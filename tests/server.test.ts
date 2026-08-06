import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  notion,
  notionSchema,
} from '../src/index.js'
import {
  createMemoryNotionIdempotencyStore,
  createMemoryNotionInvalidationStore,
  createMemoryNotionRateLimiter,
  createNotionSyncHandler,
  createNotionWebhookHandler,
  resolveNotionDataSourceId,
} from '../src/server.js'
import type { NotionMutationBatch } from '../src/index.js'
import type { NotionServerEvent } from '../src/server.js'
import {
  notionPage,
  notionProperties,
  testSchema,
  testTodo,
  type TestTodo,
} from './fixtures.js'

function createFakeNotion() {
  const pages = new Map<string, ReturnType<typeof notionPage>>()
  const calls: Array<{ url: URL; method: string; body: any }> = []
  let created = 0

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    )
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, method, body })

    if (method === 'GET' && url.pathname === '/v1/data_sources/source-1') {
      return Response.json({ object: 'data_source', properties: notionProperties })
    }

    if (method === 'POST' && url.pathname.endsWith('/query')) {
      const keys = new Set<string>()
      const collectKeys = (filter: unknown): void => {
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return
        const record = filter as Record<string, unknown>
        const richText = record.rich_text
        if (
          (record.property === 'Client ID' || record.property === 'client-id') &&
          richText &&
          typeof richText === 'object' &&
          !Array.isArray(richText) &&
          typeof (richText as Record<string, unknown>).equals === 'string'
        ) {
          keys.add((richText as { equals: string }).equals)
        }
        for (const operator of ['and', 'or'] as const) {
          const children = record[operator]
          if (Array.isArray(children)) children.forEach(collectKeys)
        }
      }
      collectKeys(body?.filter)
      const results = keys.size > 0
        ? [...pages.values()].filter(
            (page) => keys.has(testSchema.parsePage(page).id) && !page.in_trash,
          )
        : [...pages.values()].filter((page) => !page.in_trash)
      return Response.json({ results, has_more: false, next_cursor: null })
    }

    if (method === 'POST' && url.pathname === '/v1/pages') {
      created += 1
      const pageId = `page-${created}`
      const row = testTodo({
        id: body.properties['Client ID'].rich_text[0].text.content,
        title: body.properties.Task.title[0].text.content,
        completed: body.properties.Done.checkbox,
        priority: body.properties.Priority.select?.name ?? null,
        dueDate: body.properties.Due.date?.start ?? null,
        notionPageId: pageId,
        notionUrl: `https://notion.so/${pageId}`,
      })
      const page = notionPage(row, pageId)
      pages.set(pageId, page)
      return Response.json(page)
    }

    const pageId = url.pathname.match(/^\/v1\/pages\/(.+)$/)?.[1]
    if (pageId && method === 'GET') {
      const page = pages.get(pageId)
      return page
        ? Response.json(page)
        : Response.json({ code: 'object_not_found', message: 'Missing' }, { status: 404 })
    }

    if (pageId && method === 'PATCH') {
      const existing = pages.get(pageId)
      if (!existing) {
        return Response.json(
          { code: 'object_not_found', message: 'Missing' },
          { status: 404 },
        )
      }
      if (body.in_trash === true) {
        existing.in_trash = true
        return Response.json(existing)
      }
      const current = testSchema.parsePage(existing)
      const updated = notionPage(
        {
          ...current,
          title:
            body.properties.Task?.title?.[0]?.text?.content ?? current.title,
          completed:
            body.properties.Done?.checkbox ?? current.completed,
          priority:
            body.properties.Priority?.select?.name ?? current.priority,
          notionPageId: pageId,
          notionUrl: existing.url,
        },
        pageId,
      )
      pages.set(pageId, updated)
      return Response.json(updated)
    }

    return Response.json(
      { code: 'unhandled', message: `${method} ${url.pathname}` },
      { status: 500 },
    )
  })

  return { fetch, calls, pages, get createCount() { return created } }
}

describe('createNotionSyncHandler', () => {
  it('uses the data source ID embedded in a generated schema', async () => {
    const notionApi = createFakeNotion()
    const schema = notionSchema(testSchema.fields, { dataSourceId: 'source-1' })
    const handler = createNotionSyncHandler({
      token: 'secret',
      schema,
      fetch: notionApi.fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
    })

    const response = await handler(new Request('http://app.test/api/todos'))

    expect(response.status).toBe(200)
    expect(notionApi.calls.some(({ url }) => url.pathname.includes('source-1'))).toBe(
      true,
    )
  })

  it('verifies webhook signatures and deduplicates matching invalidations', async () => {
    const invalidationStore = createMemoryNotionInvalidationStore()
    let deliveredVerificationToken: string | null = null
    const webhook = createNotionWebhookHandler({
      dataSourceId: 'source-1',
      verificationToken: 'webhook-secret',
      invalidationStore,
      onVerificationToken: (token) => {
        deliveredVerificationToken = token
      },
    })

    const verification = await webhook(
      new Request('http://app.test/webhooks/notion', {
        method: 'POST',
        body: JSON.stringify({ verification_token: 'one-time-token' }),
      }),
    )
    expect(verification.status).toBe(200)
    expect(deliveredVerificationToken).toBe('one-time-token')

    const event = JSON.stringify({
      id: 'event-1',
      type: 'page.properties_updated',
      entity: { id: 'page-1', type: 'page' },
      data: {
        parent: { type: 'data_source_id', data_source_id: 'source-1' },
      },
    })
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(event).digest('hex')}`
    const send = (body: string, value = signature) =>
      webhook(
        new Request('http://app.test/webhooks/notion', {
          method: 'POST',
          headers: { 'X-Notion-Signature': value },
          body,
        }),
      )

    expect((await send(event, 'sha256=invalid')).status).toBe(401)
    expect(await invalidationStore.getVersion('source-1')).toBe(0)
    expect((await send(event)).status).toBe(204)
    expect((await send(event)).status).toBe(204)
    expect(await invalidationStore.getVersion('source-1')).toBe(1)

    const other = JSON.stringify({
      id: 'event-2',
      type: 'data_source.content_updated',
      entity: { id: 'source-2', type: 'data_source' },
      data: {},
    })
    const otherSignature = `sha256=${createHmac('sha256', 'webhook-secret').update(other).digest('hex')}`
    expect((await send(other, otherSignature)).status).toBe(204)
    expect(await invalidationStore.getVersion('source-1')).toBe(1)
  })

  it('requires an explicit endpoint authorization policy', () => {
    expect(() =>
      createNotionSyncHandler({
        token: 'secret',
        dataSourceId: 'source-1',
        schema: testSchema,
      } as never),
    ).toThrow('An authorize callback is required.')
  })

  it('rejects unauthorized requests before contacting Notion', async () => {
    const fetch = vi.fn()
    const authorize = vi.fn(() => false)
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize,
      dangerouslyAllowEphemeralIdempotency: true,
    })

    const response = await handler(new Request('http://app.test/api/todos'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Authentication is required to sync this collection.',
        retryable: false,
      },
    })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds and validates JSON request bodies before data operations', async () => {
    const fetch = vi.fn()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      maxRequestBodyBytes: 32,
    })

    const oversized = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({ value: 'x'.repeat(100) }),
      }),
    )
    expect(oversized.status).toBe(413)
    expect((await oversized.json()).error.code).toBe('request_too_large')

    const malformedHandler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
    })
    const malformed = await malformedHandler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: '{',
      }),
    )
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error.code).toBe('invalid_json')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('times out Notion requests and propagates caller cancellation', async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
    )
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      validateSchema: false,
      minimumRequestIntervalMs: 0,
      requestTimeoutMs: 5,
      maxRetries: 0,
    })

    const timedOut = await handler(new Request('http://app.test/api/todos'))
    expect(timedOut.status).toBe(504)
    expect((await timedOut.json()).error.code).toBe('notion_request_timeout')

    const cancellableHandler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      validateSchema: false,
      minimumRequestIntervalMs: 0,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
    })
    const controller = new AbortController()
    const cancelledResponse = cancellableHandler(
      new Request('http://app.test/api/todos', { signal: controller.signal }),
    )
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    controller.abort()
    const cancelled = await cancelledResponse
    expect(cancelled.status).toBe(408)
    expect((await cancelled.json()).error.code).toBe('request_cancelled')
  })

  it('retries rate limits and honors Retry-After', async () => {
    let attempts = 0
    const events: Array<NotionServerEvent> = []
    const fetch = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        return Response.json(
          { code: 'rate_limited', message: 'Slow down' },
          { status: 429, headers: { 'Retry-After': '0' } },
        )
      }
      return Response.json({ results: [], has_more: false, next_cursor: null })
    })
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      validateSchema: false,
      minimumRequestIntervalMs: 0,
      maxRetries: 1,
      onEvent: (event) => events.push(event),
    })

    const response = await handler(new Request('http://app.test/api/todos'))
    expect(response.status).toBe(200)
    expect(attempts).toBe(2)
    expect(events.map((event) => [event.outcome, event.status])).toEqual([
      ['retry', 429],
      ['success', 200],
    ])
    expect(events.every((event) => event.operation === 'data_source.query')).toBe(
      true,
    )
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('shares one request budget across handler instances', async () => {
    const rateLimiter = createMemoryNotionRateLimiter()
    const requestTimes: Array<number> = []
    const fetch = vi.fn(async () => {
      requestTimes.push(Date.now())
      return Response.json({ results: [], has_more: false, next_cursor: null })
    })
    const createHandler = () =>
      createNotionSyncHandler({
        token: 'secret',
        dataSourceId: 'source-1',
        schema: testSchema,
        fetch: fetch as typeof globalThis.fetch,
        validateSchema: false,
        minimumRequestIntervalMs: 20,
        rateLimiter,
        rateLimitScope: 'personal-workspace-connection',
        authorize: () => true,
        readOnly: true,
      })

    await Promise.all([
      createHandler()(new Request('http://app.test/api/a')),
      createHandler()(new Request('http://app.test/api/b')),
    ])

    expect(requestTimes).toHaveLength(2)
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(15)
    expect(() =>
      createNotionSyncHandler({
        token: 'secret',
        dataSourceId: 'source-1',
        schema: testSchema,
        rateLimiter,
        authorize: () => true,
        readOnly: true,
      }),
    ).toThrow('rateLimitScope is required')
  })

  it('does not expose unexpected transport errors to the browser', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('secret-token and private note content')
    })
    const handler = createNotionSyncHandler({
      token: 'secret-token',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      validateSchema: false,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
    })

    const response = await handler(new Request('http://app.test/api/todos'))
    const body = await response.text()
    expect(response.status).toBe(500)
    expect(body).toContain('unexpected error')
    expect(body).not.toContain('secret-token')
    expect(body).not.toContain('private note content')
  })

  it('reads and idempotently replaces page markdown within the configured source', async () => {
    let markdown = 'Original note'
    let patchCount = 0
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.pathname === '/v1/pages/page-1' && !init?.method) {
        return Response.json({
          object: 'page',
          id: 'page-1',
          parent: { type: 'data_source_id', data_source_id: 'source-1' },
        })
      }
      if (url.pathname === '/v1/pages/page-1/markdown') {
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as {
            replace_content: { new_str: string }
          }
          markdown = body.replace_content.new_str
          patchCount += 1
        }
        return Response.json({
          object: 'page_markdown',
          id: 'page-1',
          markdown,
          truncated: false,
          unknown_block_ids: [],
        })
      }
      return Response.json({ code: 'unhandled' }, { status: 500 })
    })
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      pageContent: true,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
    })

    const read = await handler(
      new Request('http://app.test/api/notes?action=content&pageId=page-1'),
    )
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      pageId: 'page-1',
      markdown: 'Original note',
      truncated: false,
    })

    const mutation = {
      type: 'page_content',
      idempotencyKey: 'content-1',
      pageId: 'page-1',
      baseMarkdown: 'Original note',
      markdown: 'Edited note',
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handler(
        new Request('http://app.test/api/notes', {
          method: 'POST',
          body: JSON.stringify(mutation),
        }),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).markdown).toBe('Edited note')
    }
    expect(patchCount).toBe(1)
  })

  it('detects markdown conflicts and refuses pages outside the configured source', async () => {
    let pageSource = 'source-1'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.pathname === '/v1/pages/page-1') {
        return Response.json({
          object: 'page',
          id: 'page-1',
          parent: { type: 'data_source_id', data_source_id: pageSource },
        })
      }
      return Response.json({
        object: 'page_markdown',
        id: 'page-1',
        markdown: 'Remote edit',
        truncated: false,
        unknown_block_ids: [],
      })
    })
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      authorize: () => true,
      dangerouslyAllowEphemeralIdempotency: true,
      pageContent: true,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
    })
    const mutation = new Request('http://app.test/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        type: 'page_content',
        idempotencyKey: 'content-conflict',
        pageId: 'page-1',
        baseMarkdown: 'Original note',
        markdown: 'Local edit',
      }),
    })

    const conflict = await handler(mutation)
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.code).toBe('page_content_conflict')

    pageSource = 'different-source'
    const outside = await handler(
      new Request('http://app.test/api/notes?action=content&pageId=page-1'),
    )
    expect(outside.status).toBe(404)
    expect((await outside.json()).error.code).toBe('page_outside_data_source')
  })

  it('resolves a single-source database container to its data source ID', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.pathname === '/v1/data_sources/database-1') {
        return Response.json(
          { code: 'object_not_found', message: 'Not a data source' },
          { status: 404 },
        )
      }
      return Response.json({
        object: 'database',
        data_sources: [{ id: 'source-1', name: 'Tasks' }],
      })
    })

    await expect(
      resolveNotionDataSourceId({
        token: 'personal-access-token',
        id: 'database-1',
        fetch: fetch as typeof globalThis.fetch,
        baseUrl: 'https://api.notion.test',
      }),
    ).resolves.toBe('source-1')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('resolves a pasted Notion database URL', async () => {
    const databaseId = '0123456789abcdef0123456789abcdef'
    const requestedPaths: Array<string> = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      requestedPaths.push(url.pathname)
      if (url.pathname.startsWith('/v1/data_sources/')) {
        return Response.json({ message: 'Not a data source' }, { status: 404 })
      }
      return Response.json({
        object: 'database',
        data_sources: [{ id: 'source-1', name: 'Journal' }],
      })
    })

    await expect(
      resolveNotionDataSourceId({
        token: 'personal-access-token',
        id: `https://www.notion.so/workspace/Journal-${databaseId}?v=view-id`,
        fetch: fetch as typeof globalThis.fetch,
        baseUrl: 'https://api.notion.test',
      }),
    ).resolves.toBe('source-1')
    expect(requestedPaths).toEqual([
      `/v1/data_sources/${databaseId}`,
      `/v1/databases/${databaseId}`,
    ])
  })

  it('accepts the app.notion.com URL produced by Copy link', async () => {
    const databaseId = '3b4c711c0ceb80248495e50e76712f0f'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.pathname === `/v1/data_sources/${databaseId}`) {
        return Response.json({ object: 'data_source' })
      }
      return Response.json({ message: 'Missing' }, { status: 404 })
    })

    await expect(
      resolveNotionDataSourceId({
        token: 'personal-access-token',
        id: `https://app.notion.com/p/brianlovin/${databaseId}?v=view-id`,
        fetch: fetch as typeof globalThis.fetch,
        baseUrl: 'https://api.notion.test',
      }),
    ).resolves.toBe(databaseId)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('lists names and IDs when a database has multiple data sources', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.pathname.startsWith('/v1/data_sources/')) {
        return Response.json({ message: 'Not a data source' }, { status: 404 })
      }
      return Response.json({
        data_sources: [
          { id: 'source-tasks', name: 'Tasks' },
          { id: 'source-projects', name: 'Projects' },
        ],
      })
    })

    await expect(
      resolveNotionDataSourceId({
        token: 'personal-access-token',
        id: 'database-1',
        fetch: fetch as typeof globalThis.fetch,
        baseUrl: 'https://api.notion.test',
      }),
    ).rejects.toThrow(
      'Tasks (source-tasks), Projects (source-projects)',
    )
  })

  it('keeps an already-valid data source ID', async () => {
    const fetch = vi.fn(async () => Response.json({ object: 'data_source' }))

    await expect(
      resolveNotionDataSourceId({
        token: 'personal-access-token',
        id: 'source-1',
        fetch: fetch as typeof globalThis.fetch,
      }),
    ).resolves.toBe('source-1')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('validates the configured Notion data source schema', async () => {
    const notion = createFakeNotion()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      dangerouslyAllowUnauthenticated: true,
      dangerouslyAllowEphemeralIdempotency: true,
    })

    const response = await handler(
      new Request('http://app.test/api/todos?action=schema'),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      dataSourceId: 'source-1',
      mismatches: [],
    })
  })

  it('opts into complete paginated values for long relation properties', async () => {
    const schema = notionSchema({
      id: notion.id({ name: 'Client ID', id: 'client-id' }),
      title: notion.title({ name: 'Task', id: 'title' }),
      related: notion.relation({ name: 'Related', id: 'relation-id' }),
      notionPageId: notion.pageId(),
    })
    const propertyRequests: Array<URL> = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (init?.method === 'POST' && url.pathname.endsWith('/query')) {
        return Response.json({
          results: [{
            id: 'page-with-many-relations',
            created_time: '2026-08-04T12:00:00.000Z',
            last_edited_time: '2026-08-04T12:00:00.000Z',
            url: 'https://notion.so/page-with-many-relations',
            properties: {
              'Client ID': {
                id: 'client-id',
                type: 'rich_text',
                rich_text: [{ plain_text: 'row-1' }],
              },
              Task: {
                id: 'title',
                type: 'title',
                title: [{ plain_text: 'Complete relations' }],
              },
              Related: {
                id: 'relation-id',
                type: 'relation',
                relation: [{ id: 'truncated-value' }],
                has_more: true,
              },
            },
          }],
          has_more: false,
          next_cursor: null,
        })
      }
      if (url.pathname.includes('/properties/relation-id')) {
        propertyRequests.push(url)
        const second = url.searchParams.get('start_cursor') === 'property-page-2'
        return Response.json({
          object: 'list',
          results: (second ? ['related-c'] : ['related-a', 'related-b']).map(
            (id) => ({
              object: 'property_item',
              type: 'relation',
              relation: { id },
            }),
          ),
          has_more: !second,
          next_cursor: second ? null : 'property-page-2',
        })
      }
      if (url.pathname === '/v1/data_sources/source-1') {
        return Response.json({
          properties: {
            'Client ID': { id: 'client-id', type: 'rich_text' },
            Task: { id: 'title', type: 'title' },
            Related: { id: 'relation-id', type: 'relation' },
          },
        })
      }
      return Response.json({ code: 'unhandled' }, { status: 500 })
    })
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema,
      fetch: fetch as typeof globalThis.fetch,
      minimumRequestIntervalMs: 0,
      authorize: () => true,
      readOnly: true,
      completeProperties: ['related'],
    })

    const response = await handler(new Request('http://app.test/api/tasks'))
    expect(response.status).toBe(200)
    expect((await response.json()).rows[0].related).toEqual([
      { id: 'related-a' },
      { id: 'related-b' },
      { id: 'related-c' },
    ])
    expect(propertyRequests).toHaveLength(2)
    expect(propertyRequests[1]?.searchParams.get('start_cursor')).toBe(
      'property-page-2',
    )
  })

  it('sorts read-only list requests and rejects mutations without an idempotency store', async () => {
    const notion = createFakeNotion()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      readOnly: true,
      sorts: [{ field: 'priority', direction: 'descending' }],
      filter: {
        and: [
          { field: 'completed', operator: 'equals', value: false },
          { field: 'priority', operator: 'does_not_equal', value: 'Low' },
        ],
      },
    })

    const list = await handler(new Request('http://app.test/api/listening'))
    expect(list.status).toBe(200)
    const query = notion.calls.find(
      (call) => call.method === 'POST' && call.url.pathname.endsWith('/query'),
    )
    expect(query?.body.sorts).toEqual([
      { property: 'Priority', direction: 'descending' },
    ])
    expect(query?.body.filter).toEqual({
      and: [
        { property: 'Done', checkbox: { equals: false } },
        { property: 'Priority', select: { does_not_equal: 'Low' } },
      ],
    })

    const callsBeforeMutation = notion.calls.length
    const mutation = await handler(
      new Request('http://app.test/api/listening', {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: 'blocked', mutations: [] }),
      }),
    )
    expect(mutation.status).toBe(405)
    expect((await mutation.json()).error.code).toBe('read_only_collection')
    expect(notion.calls).toHaveLength(callsBeforeMutation)
  })

  it('rejects incompatible fixed filter operators during handler setup', () => {
    expect(() =>
      createNotionSyncHandler({
        token: 'secret',
        dataSourceId: 'source-1',
        schema: testSchema,
        authorize: () => true,
        readOnly: true,
        filter: {
          field: 'completed',
          operator: 'contains',
          value: false,
        },
      }),
    ).toThrow('contains operator is not supported for completed')
  })

  it('creates idempotently, updates, lists, and trashes Notion pages', async () => {
    const notion = createFakeNotion()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      dangerouslyAllowUnauthenticated: true,
      dangerouslyAllowEphemeralIdempotency: true,
    })
    const row = testTodo()
    const insert: NotionMutationBatch<TestTodo> = {
      idempotencyKey: 'tx-1',
      mutations: [{ type: 'insert', key: row.id, value: row }],
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handler(
        new Request('http://app.test/api/todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(insert),
        }),
      )
      expect(response.status).toBe(200)
    }
    expect(notion.createCount).toBe(1)

    const pageId = [...notion.pages.keys()][0]!
    const persisted = testSchema.parsePage(notion.pages.get(pageId)!)
    const update: NotionMutationBatch<TestTodo> = {
      idempotencyKey: 'tx-2',
      mutations: [
        {
          type: 'update',
          key: row.id,
          value: { ...persisted, completed: true },
          base: { completed: false },
          changes: { completed: true },
        },
      ],
    }
    const updateResponse = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      }),
    )
    expect(updateResponse.status).toBe(200)
    expect(testSchema.parsePage(notion.pages.get(pageId)!).completed).toBe(true)

    const listResponse = await handler(
      new Request('http://app.test/api/todos?pageSize=50'),
    )
    expect(listResponse.status).toBe(200)
    expect((await listResponse.json()).rows).toHaveLength(1)

    const remove: NotionMutationBatch<TestTodo> = {
      idempotencyKey: 'tx-3',
      mutations: [
        { type: 'delete', key: row.id, value: testSchema.parsePage(notion.pages.get(pageId)!) },
      ],
    }
    const deleteResponse = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(remove),
      }),
    )
    expect(deleteResponse.status).toBe(200)
    expect(notion.pages.get(pageId)?.in_trash).toBe(true)
    const trashCall = notion.calls.find(
      (call) => call.url.pathname === `/v1/pages/${pageId}` && call.body?.in_trash,
    )
    expect(trashCall?.body).toEqual({ in_trash: true })
  })

  it('coalesces a full insert batch into one duplicate lookup', async () => {
    const notion = createFakeNotion()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })
    const rows = Array.from({ length: 50 }, (_, index) =>
      testTodo({ id: `bulk-${index}`, title: `Bulk task ${index}` }),
    )

    const response = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: 'bulk-insert',
          mutations: rows.map((row) => ({
            type: 'insert',
            key: row.id,
            value: row,
          })),
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(notion.createCount).toBe(50)
    const lookups = notion.calls.filter(
      ({ method, url }) => method === 'POST' && url.pathname.endsWith('/query'),
    )
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.body.filter.or).toHaveLength(50)
  })

  it('reconciles existing insert keys with one batch lookup', async () => {
    const notion = createFakeNotion()
    const existing = testTodo({ id: 'already-there', notionPageId: 'existing-page' })
    notion.pages.set('existing-page', notionPage(existing, 'existing-page'))
    const created = testTodo({ id: 'new-row', title: 'Create me' })
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })

    const response = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: 'mixed-insert',
          mutations: [existing, created].map((row) => ({
            type: 'insert',
            key: row.id,
            value: row,
          })),
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(notion.createCount).toBe(1)
    expect(
      notion.calls.filter(
        ({ method, url }) => method === 'POST' && url.pathname.endsWith('/query'),
      ),
    ).toHaveLength(1)
  })

  it('fails closed when Notion truncates a query at its result limit', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        results: [],
        has_more: false,
        next_cursor: null,
        request_status: {
          type: 'incomplete',
          incomplete_reason: 'query_result_limit_reached',
        },
      }),
    )
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      validateSchema: false,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      readOnly: true,
    })

    const response = await handler(new Request('http://app.test/api/todos'))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: {
        code: 'notion_query_result_limit',
        message:
          'Notion truncated this query at 10,000 matching pages. Narrow the collection filter or split the data into multiple collections before syncing.',
        retryable: false,
      },
    })
  })

  it('serializes the same insert across handler instances and replays its result', async () => {
    const notion = createFakeNotion()
    const idempotencyStore = createMemoryNotionIdempotencyStore()
    const createHandler = () =>
      createNotionSyncHandler({
        token: 'secret',
        dataSourceId: 'source-1',
        schema: testSchema,
        fetch: notion.fetch as typeof fetch,
        minimumRequestIntervalMs: 0,
        maxRetries: 0,
        authorize: () => true,
        idempotencyStore,
      })
    const firstHandler = createHandler()
    const secondHandler = createHandler()
    const row = testTodo({ id: 'concurrent-insert' })
    const body = (idempotencyKey: string) =>
      JSON.stringify({
        idempotencyKey,
        mutations: [{ type: 'insert', key: row.id, value: row }],
      })

    const [first, second] = await Promise.all([
      firstHandler(
        new Request('http://app.test/api/todos', {
          method: 'POST',
          body: body('tab-a-transaction'),
        }),
      ),
      secondHandler(
        new Request('http://app.test/api/todos', {
          method: 'POST',
          body: body('tab-b-transaction'),
        }),
      ),
    ])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(await first.json()).toEqual(await second.json())
    expect(notion.createCount).toBe(1)

    const replay = await secondHandler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: body('tab-b-transaction'),
      }),
    )
    expect(replay.status).toBe(200)
    expect(notion.createCount).toBe(1)
  })

  it('checkpoints each mutation so a partial batch retry cannot duplicate earlier inserts', async () => {
    const notion = createFakeNotion()
    let rejectSecondOnce = true
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        )
        if (
          rejectSecondOnce &&
          init?.method === 'POST' &&
          url.pathname === '/v1/pages' &&
          String(init.body).includes('batch-second')
        ) {
          rejectSecondOnce = false
          return Response.json(
            { code: 'service_unavailable', message: 'Injected failure' },
            { status: 503 },
          )
        }
        return notion.fetch(input, init)
      },
    )
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })
    const firstRow = testTodo({ id: 'batch-first', title: 'First' })
    const secondRow = testTodo({ id: 'batch-second', title: 'Second' })
    const body = JSON.stringify({
      idempotencyKey: 'partial-batch',
      mutations: [
        { type: 'insert', key: firstRow.id, value: firstRow },
        { type: 'insert', key: secondRow.id, value: secondRow },
      ],
    })

    const failed = await handler(
      new Request('http://app.test/api/todos', { method: 'POST', body }),
    )
    expect(failed.status).toBe(503)
    const retried = await handler(
      new Request('http://app.test/api/todos', { method: 'POST', body }),
    )

    expect(retried.status).toBe(200)
    expect(notion.createCount).toBe(2)
    expect(
      [...notion.pages.values()].map((page) => testSchema.parsePage(page).id),
    ).toEqual(['batch-first', 'batch-second'])
  })

  it('recovers an insert when the response from Notion is lost after creation', async () => {
    const notion = createFakeNotion()
    let loseCreateResponse = true
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        )
        const response = await notion.fetch(input, init)
        if (
          loseCreateResponse &&
          init?.method === 'POST' &&
          url.pathname === '/v1/pages'
        ) {
          loseCreateResponse = false
          throw new TypeError('The upstream response disappeared.')
        }
        return response
      },
    )
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      minimumRequestIntervalMs: 0,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })
    const row = testTodo({ id: 'upstream-lost-response' })
    const body = JSON.stringify({
      idempotencyKey: 'upstream-lost-response-key',
      mutations: [{ type: 'insert', key: row.id, value: row }],
    })

    expect(
      (
        await handler(
          new Request('http://app.test/api/todos', { method: 'POST', body }),
        )
      ).status,
    ).toBe(500)
    const retry = await handler(
      new Request('http://app.test/api/todos', { method: 'POST', body }),
    )

    expect(retry.status).toBe(200)
    expect(notion.createCount).toBe(1)
  })

  it('retries an explicitly rate-limited page create', async () => {
    const notion = createFakeNotion()
    let createAttempts = 0
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        )
        if (init?.method === 'POST' && url.pathname === '/v1/pages') {
          createAttempts += 1
          if (createAttempts === 1) {
            return Response.json(
              { code: 'rate_limited', message: 'Slow down' },
              { status: 429, headers: { 'Retry-After': '0' } },
            )
          }
        }
        return notion.fetch(input, init)
      },
    )
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 1,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })
    const row = testTodo({ id: 'rate-limited-create' })

    const response = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: 'rate-limited-create',
          mutations: [{ type: 'insert', key: row.id, value: row }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(createAttempts).toBe(2)
    expect(notion.createCount).toBe(1)
  })

  it('rejects an idempotency key reused for another insert payload', async () => {
    const notion = createFakeNotion()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })
    const first = testTodo({ id: 'reuse-a', title: 'First payload' })
    const second = testTodo({ id: 'reuse-b', title: 'Second payload' })
    const send = (row: TestTodo) =>
      handler(
        new Request('http://app.test/api/todos', {
          method: 'POST',
          body: JSON.stringify({
            idempotencyKey: 'reused-key',
            mutations: [{ type: 'insert', key: row.id, value: row }],
          }),
        }),
      )

    expect((await send(first)).status).toBe(200)
    const conflict = await send(second)
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.code).toBe('idempotency_key_reused')
    expect(notion.createCount).toBe(1)
  })

  it('refuses to start without a durable or explicitly ephemeral idempotency policy', () => {
    const notion = createFakeNotion()
    expect(() =>
      createNotionSyncHandler({
        token: 'secret',
        dataSourceId: 'source-1',
        schema: testSchema,
        fetch: notion.fetch as typeof fetch,
        minimumRequestIntervalMs: 0,
        maxRetries: 0,
        authorize: () => true,
      } as never),
    ).toThrow('A durable idempotencyStore is required.')
    expect(notion.createCount).toBe(0)
  })

  it('merges unrelated remote property edits and rejects same-property conflicts', async () => {
    const notion = createFakeNotion()
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notion.fetch as typeof fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      idempotencyStore: createMemoryNotionIdempotencyStore(),
    })
    const original = testTodo({ id: 'property-merge', title: 'Original', priority: 'High' })
    const insert = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: 'property-insert',
          mutations: [{ type: 'insert', key: original.id, value: original }],
        }),
      }),
    )
    expect(insert.status).toBe(200)
    const pageId = [...notion.pages.keys()][0]!
    const inserted = testSchema.parsePage(notion.pages.get(pageId)!)

    notion.pages.set(
      pageId,
      notionPage({ ...inserted, priority: 'Low' }, pageId),
    )
    const unrelated = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: 'property-unrelated',
          mutations: [
            {
              type: 'update',
              key: original.id,
              value: { ...inserted, title: 'Local title' },
              base: { title: 'Original' },
              changes: { title: 'Local title' },
            },
          ],
        }),
      }),
    )
    expect(unrelated.status).toBe(200)
    expect(testSchema.parsePage(notion.pages.get(pageId)!)).toMatchObject({
      title: 'Local title',
      priority: 'Low',
    })
    const propertyPatch = [...notion.calls]
      .reverse()
      .find((call) => call.method === 'PATCH' && call.body?.properties)
    expect(Object.keys(propertyPatch?.body.properties ?? {})).toEqual(['Task'])

    const afterMerge = testSchema.parsePage(notion.pages.get(pageId)!)
    notion.pages.set(
      pageId,
      notionPage({ ...afterMerge, title: 'Remote title' }, pageId),
    )
    const sameProperty = await handler(
      new Request('http://app.test/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: 'property-conflict',
          mutations: [
            {
              type: 'update',
              key: original.id,
              value: { ...afterMerge, title: 'Second local title' },
              base: { title: 'Local title' },
              changes: { title: 'Second local title' },
            },
          ],
        }),
      }),
    )
    const conflictBody = await sameProperty.json()
    expect(sameProperty.status).toBe(409)
    expect(conflictBody.error).toMatchObject({
      code: 'property_conflict',
      conflicts: [
        {
          field: 'title',
          baseValue: 'Local title',
          localValue: 'Second local title',
          remoteValue: 'Remote title',
        },
      ],
    })
    expect(testSchema.parsePage(notion.pages.get(pageId)!).title).toBe(
      'Remote title',
    )
  })

  it('returns a useful error for a mismatched data source', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ properties: { Task: { type: 'rich_text' } } }),
    )
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: fetch as typeof globalThis.fetch,
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      dangerouslyAllowUnauthenticated: true,
      dangerouslyAllowEphemeralIdempotency: true,
    })

    const response = await handler(new Request('http://app.test/api/todos'))
    const body = await response.json()
    expect(response.status).toBe(422)
    expect(body.error.code).toBe('schema_mismatch')
    expect(body.error.message).toContain('Client ID')
  })
})
