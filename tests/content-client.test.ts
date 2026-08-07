import { createCollection } from '@tanstack/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createNotionPageContentClient,
  notionCollectionOptions,
  type NotionPageContentSnapshot,
} from '../src/index.js'
import {
  createMemoryNotionStorage,
  type NotionPageContent,
} from '../src/advanced.js'
import { testSchema, testTodo } from './fixtures.js'

function content(markdown: string): NotionPageContent {
  return {
    pageId: 'page-1',
    markdown,
    truncated: false,
    unknownBlockIds: [],
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createNotionPageContentClient', () => {
  it('creates a draft when updating a known collection row without createDraft', async () => {
    const row = testTodo({
      id: 'implicit-draft',
      notionPageId: 'page-implicit-draft',
    })
    const collection = {
      config: {
        schema: {
          getKey: (value: typeof row) => value.id,
          getPageId: (value: typeof row) => value.notionPageId,
        },
      },
      values: () => [row].values(),
      subscribeChanges: () => ({ unsubscribe() {} }),
    }
    const client = createNotionPageContentClient({
      id: 'implicit-draft',
      endpoint: 'http://app.test/api/notes',
      collection,
      storage: createMemoryNotionStorage(),
      fetch: vi.fn(async () => Response.json(content('Original'))) as typeof fetch,
      autoStart: false,
      pollIntervalMs: 0,
    })

    await client.update('implicit-draft', 'Draft without setup')

    expect(client.get('implicit-draft')).toMatchObject({
      markdown: 'Draft without setup',
      pending: true,
      notionPageId: 'page-implicit-draft',
    })
    client.cleanup()
  })

  it('aborts page-content requests at the configured timeout', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    )
    const client = createNotionPageContentClient({
      id: 'timeout-content',
      endpoint: 'http://app.test/api/notes',
      storage: createMemoryNotionStorage(),
      fetch: fetch as typeof globalThis.fetch,
      requestTimeoutMs: 10,
      pollIntervalMs: 0,
    })

    const loading = client.load('note-1', 'page-1')
    const expectation = expect(loading).rejects.toMatchObject({
      code: 'request_timeout',
      message: 'The page-content request timed out.',
    })
    await vi.advanceTimersByTimeAsync(10)

    await expectation
    client.cleanup()
  })

  it('persists every draft immediately and debounces remote writes', async () => {
    vi.useFakeTimers()
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    const sentMarkdown: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        sentMarkdown.push(body.markdown)
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 750,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'First draft')

    const afterFirstEdit = await storage.load<NotionPageContentSnapshot>(
      'notes:page-content',
    )
    expect(afterFirstEdit?.rows[0]).toMatchObject({
      markdown: 'First draft',
      baseMarkdown: 'Original',
      pending: true,
      status: 'saved-local',
    })
    expect(sentMarkdown).toEqual([])

    await vi.advanceTimersByTimeAsync(749)
    await client.update('note-1', 'Final draft')
    await vi.advanceTimersByTimeAsync(749)
    expect(sentMarkdown).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await client.flush('note-1')
    expect(sentMarkdown).toEqual(['Final draft'])
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Final draft',
      baseMarkdown: 'Final draft',
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('reloads and reapplies a draft after a storage revision conflict', async () => {
    const storage = createMemoryNotionStorage()
    const fetch = vi.fn(async () => Response.json(content('Original')))
    const first = createNotionPageContentClient({
      id: 'revision-conflict-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
      autoStart: false,
    })
    const second = createNotionPageContentClient({
      id: 'revision-conflict-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
      autoStart: false,
    })

    await first.load('note-1', 'page-1')
    await second.load('note-1', 'page-1')
    await first.update('note-1', 'First tab draft')
    await second.update('note-1', 'Second tab draft')

    expect(second.get('note-1')).toMatchObject({
      markdown: 'Second tab draft',
      pending: true,
      status: 'saved-local',
    })
    const persisted = await storage.load<NotionPageContentSnapshot>(
      'revision-conflict-content:page-content',
    )
    expect(persisted?.rows[0]).toMatchObject({
      markdown: 'Second tab draft',
      pending: true,
    })

    first.cleanup()
    second.cleanup()
  })

  it('keeps the local draft visible when every CAS retry fails', async () => {
    const backing = createMemoryNotionStorage()
    await backing.save<NotionPageContentSnapshot>(
      'persistent-cas-failure:page-content',
      {
        version: 2,
        revision: 1,
        outbox: [],
        rows: [
          {
            key: 'note-1',
            notionPageId: 'page-1',
            markdown: 'Original',
            baseMarkdown: 'Original',
            remoteMarkdown: null,
            revision: 0,
            pending: false,
            truncated: false,
            unknownBlockIds: [],
            status: 'synced',
            lastSyncedAt: null,
            error: null,
          },
        ],
        lastSyncedAt: null,
      },
    )
    const storage = {
      ...backing,
      compareAndSet: async () => false,
    }
    const client = createNotionPageContentClient({
      id: 'persistent-cas-failure',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: vi.fn(async () => Response.json(content('Original'))) as typeof globalThis.fetch,
      debounceMs: 60_000,
      autoStart: false,
    })
    await client.ready()
    let notifications = 0
    const unsubscribe = client.subscribe(() => {
      notifications += 1
    })

    await expect(client.update('note-1', 'Local draft')).rejects.toMatchObject({
      code: 'storage_revision_conflict',
    })

    expect(client.get('note-1')).toMatchObject({
      markdown: 'Local draft',
      pending: true,
      status: 'saved-local',
    })
    expect(notifications).toBeGreaterThan(0)

    unsubscribe()
    client.cleanup()
  })

  it('coalesces edits made while a content write is in flight', async () => {
    const storage = createMemoryNotionStorage()
    let resolveFirstWrite!: (response: Response) => void
    let postCount = 0
    const sentMarkdown: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json(content('Original'))
      const body = JSON.parse(String(init.body)) as { markdown: string }
      sentMarkdown.push(body.markdown)
      postCount += 1
      if (postCount === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirstWrite = resolve
        })
      }
      return Response.json(content(body.markdown))
    })
    const client = createNotionPageContentClient({
      id: 'in-flight-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'First draft')
    const firstFlush = client.flush('note-1')
    await vi.waitFor(() => expect(postCount).toBe(1))

    await client.update('note-1', 'Typed during request')
    resolveFirstWrite(Response.json(content('First draft')))
    await firstFlush
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Typed during request',
      baseMarkdown: 'First draft',
      pending: true,
    })

    await client.flush('note-1')
    expect(sentMarkdown).toEqual(['First draft', 'Typed during request'])
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Typed during request',
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('restores a pending offline draft after recreating the client', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = true
    let remoteMarkdown = 'Original'
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const first = createNotionPageContentClient({
      id: 'offline-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
      isOnline: () => isOnline,
    })
    await first.load('note-1', 'page-1')
    isOnline = false
    await first.update('note-1', 'Offline journal entry')
    first.cleanup()

    const restored = createNotionPageContentClient({
      id: 'offline-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
      isOnline: () => isOnline,
    })
    await restored.ready()
    expect(restored.get('note-1')).toMatchObject({
      markdown: 'Offline journal entry',
      pending: true,
      status: 'offline',
    })

    isOnline = true
    await restored.flush('note-1')
    expect(restored.get('note-1')).toMatchObject({
      pending: false,
      status: 'synced',
    })
    restored.cleanup()
  })

  it('waits for authenticated resume before restoring pending content', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = true
    let remoteMarkdown = 'Original'
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const first = createNotionPageContentClient({
      id: 'authenticated-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 1,
      isOnline: () => isOnline,
    })
    await first.load('note-1', 'page-1')
    isOnline = false
    await first.update('note-1', 'Saved before reload')
    first.cleanup()

    fetch.mockClear()
    isOnline = true
    const restored = createNotionPageContentClient({
      id: 'authenticated-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 1,
      isOnline: () => isOnline,
      autoStart: false,
    })
    await restored.ready()
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(fetch).not.toHaveBeenCalled()
    expect(restored.get('note-1')).toMatchObject({
      markdown: 'Saved before reload',
      pending: true,
      status: 'saved-local',
    })

    await restored.resumeSync()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(restored.get('note-1')).toMatchObject({
      pending: false,
      status: 'synced',
    })
    restored.cleanup()
  })

  it('revalidates watched page content when the app regains focus', async () => {
    const browserWindow = new EventTarget()
    vi.stubGlobal('window', browserWindow)
    let remoteMarkdown = 'Original'
    const client = createNotionPageContentClient({
      id: 'focused-content',
      endpoint: 'http://app.test/api/notes',
      storage: createMemoryNotionStorage(),
      fetch: vi.fn(async () => Response.json(content(remoteMarkdown))),
      isOnline: () => true,
      pollIntervalMs: 0,
    })

    await client.load('note-1', 'page-1')
    const unwatch = client.watch('note-1')
    remoteMarkdown = 'Edited in Notion'
    browserWindow.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => {
      expect(client.get('note-1')?.markdown).toBe('Edited in Notion')
    })
    unwatch()
    client.cleanup()
  })

  it('revalidates watched content after a webhook invalidation version changes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new EventTarget())
    let version = 0
    let remoteMarkdown = 'Original'
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      return Response.json(
        url.searchParams.get('action') === 'version'
          ? { version }
          : content(remoteMarkdown),
      )
    })
    const client = createNotionPageContentClient({
      id: 'invalidated-content',
      endpoint: 'http://app.test/api/notes',
      storage: createMemoryNotionStorage(),
      fetch: fetch as typeof globalThis.fetch,
      isOnline: () => true,
      pollIntervalMs: 0,
      invalidationPollIntervalMs: 10,
    })

    await client.load('note-1', 'page-1')
    const unwatch = client.watch('note-1')
    await vi.advanceTimersByTimeAsync(10)
    version = 1
    remoteMarkdown = 'Changed after webhook'
    await vi.advanceTimersByTimeAsync(10)

    expect(client.get('note-1')?.markdown).toBe('Changed after webhook')
    unwatch()
    client.cleanup()
  })

  it('attaches every offline draft when its collection row receives a page ID', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    let remoteRow = testTodo({ id: 'offline-note', title: 'Offline note' })
    let remoteMarkdown = ''
    let contentWrites = 0
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.searchParams.get('action') === 'content') {
        return Response.json(content(remoteMarkdown))
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          type?: string
          markdown?: string
          mutations?: Array<{ value: typeof remoteRow }>
        }
        if (body.type === 'page_content') {
          contentWrites += 1
          remoteMarkdown = body.markdown ?? ''
          return Response.json(content(remoteMarkdown))
        }
        remoteRow = {
          ...body.mutations![0]!.value,
          notionPageId: 'page-1',
          notionUrl: 'https://notion.so/page-1',
        }
        return Response.json({ rows: [remoteRow], deletedKeys: [] })
      }
      return Response.json({
        rows: remoteRow.notionPageId ? [remoteRow] : [],
        hasMore: false,
        nextCursor: null,
      })
    })
    const createRows = () =>
      createCollection(
        notionCollectionOptions({
          tuning: {
            isOnline: () => isOnline,
            pollIntervalMs: 0,
          },
          id: 'offline-note-rows',
          endpoint: 'http://app.test/api/notes',
          schema: testSchema,
          storage,
          fetch: fetch as typeof globalThis.fetch,
        }),
      )
    const createContent = (collection: ReturnType<typeof createRows>) =>
      createNotionPageContentClient({
        id: 'offline-note-content',
        endpoint: 'http://app.test/api/notes',
        collection,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        debounceMs: 1,
      })

    const offlineRows = createRows()
    const offlineContent = createContent(offlineRows)
    await offlineRows.preload()
    await offlineContent.createDraft('offline-note', '# Written offline')
    const transaction = offlineRows.insert({
      id: 'offline-note',
      title: 'Offline note',
    })
    await transaction.isPersisted.promise
    offlineContent.cleanup()
    await offlineRows.cleanup()

    isOnline = true
    const restoredRows = createRows()
    const restoredContent = createContent(restoredRows)
    await restoredRows.preload()
    await restoredRows.utils.resumeSync()

    await vi.waitFor(() => {
      expect(restoredContent.get('offline-note')).toMatchObject({
        notionPageId: 'page-1',
        markdown: '# Written offline',
        pending: false,
        status: 'synced',
      })
    })
    expect(contentWrites).toBe(1)
    expect(remoteMarkdown).toBe('# Written offline')
    restoredContent.cleanup()
    await restoredRows.cleanup()
  })

  it('keeps a new offline row draft under its client key until Notion assigns a page', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = ''
    const sentPageIds: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          pageId: string
          markdown: string
        }
        sentPageIds.push(body.pageId)
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'new-note-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.createDraft('client-note-1')
    await client.update('client-note-1', 'Written before the page exists')
    await client.flush('client-note-1')
    expect(sentPageIds).toEqual([])
    expect(client.get('client-note-1')).toMatchObject({
      notionPageId: null,
      pending: true,
    })

    await client.attachPage('client-note-1', 'page-1')
    await client.flush('client-note-1')
    expect(sentPageIds).toEqual(['page-1'])
    expect(client.get('client-note-1')).toMatchObject({
      key: 'client-note-1',
      notionPageId: 'page-1',
      pending: false,
      markdown: 'Written before the page exists',
    })
    client.cleanup()
  })

  it('keeps both versions when Notion changed and resolves explicitly', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json(
          {
            error: {
              code: 'page_content_conflict',
              message: 'The page changed in Notion after this draft was loaded.',
              retryable: false,
            },
          },
          { status: 409 },
        )
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'conflict-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'Local draft')
    remoteMarkdown = 'Remote edit'
    await client.flush('note-1')

    expect(client.get('note-1')).toMatchObject({
      markdown: 'Local draft',
      remoteMarkdown: 'Remote edit',
      pending: true,
      status: 'conflict',
    })

    await client.acceptRemote('note-1')
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Remote edit',
      remoteMarkdown: null,
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('retries a lost successful response without losing the pending draft', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    let loseResponse = true
    let remoteWrites = 0
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        if (remoteMarkdown !== body.markdown) {
          remoteMarkdown = body.markdown
          remoteWrites += 1
        }
        if (loseResponse) {
          loseResponse = false
          throw new TypeError('The successful response disappeared.')
        }
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'lost-response-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'Durable draft')
    await expect(client.flush('note-1')).rejects.toThrow(
      'The successful response disappeared.',
    )
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Durable draft',
      pending: true,
      status: 'error',
    })

    await client.flush('note-1')
    expect(remoteWrites).toBe(1)
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Durable draft',
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('automatically retries a persisted content error after recreation', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    let failWrite = true
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        if (failWrite) throw new TypeError('Session was not ready.')
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const first = createNotionPageContentClient({
      id: 'restored-error-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 1,
    })
    await first.load('note-1', 'page-1')
    await first.update('note-1', 'Retry after reload')
    await expect(first.flush('note-1')).rejects.toThrow('Session was not ready.')
    first.cleanup()

    failWrite = false
    const restored = createNotionPageContentClient({
      id: 'restored-error-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 1,
    })
    await restored.ready()

    await vi.waitFor(() => {
      expect(restored.get('note-1')).toMatchObject({
        markdown: 'Retry after reload',
        pending: false,
        status: 'synced',
        error: null,
      })
    })
    restored.cleanup()
  })

  it('aborts an in-flight content request and prevents later writes after cleanup', async () => {
    const storage = createMemoryNotionStorage()
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json(content('Original'))
      requestSignal = init.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => reject(requestSignal?.reason),
          { once: true },
        )
      })
    })
    const client = createNotionPageContentClient({
      id: 'cleanup-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })
    await client.load('note-1', 'page-1')
    await client.update('note-1', 'Pending during cleanup')
    const flush = client.flush('note-1')
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    const beforeCleanup = await storage.load<NotionPageContentSnapshot>(
      'cleanup-content:page-content',
    )

    client.cleanup()
    await flush

    expect(requestSignal?.aborted).toBe(true)
    expect(
      await storage.load<NotionPageContentSnapshot>(
        'cleanup-content:page-content',
      ),
    ).toEqual(beforeCleanup)
  })
})
