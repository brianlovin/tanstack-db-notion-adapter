import { createCollection } from '@tanstack/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notionCollectionOptions,
} from '../src/index.js'
import {
  createNotionSyncHandler,
} from '../src/server.js'
import {
  createMemoryNotionStorage,
  type NotionCollectionStorage,
  type NotionPersistedEnvelope,
  type NotionPersistedState,
  type NotionQuarantineRecord,
} from '../src/advanced.js'
import {
  notionPage,
  notionProperties,
  testSchema,
  testTodo,
  type TestTodo,
} from './fixtures.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notionCollectionOptions', () => {
  it('recreates a deleted row through the server without reusing insert idempotency', async () => {
    const pages = new Map<string, ReturnType<typeof notionPage>>()
    let created = 0
    const notionFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (method === 'GET' && requestUrl.pathname === '/v1/data_sources/source-1') {
        return Response.json({ object: 'data_source', properties: notionProperties })
      }
      if (method === 'POST' && requestUrl.pathname.endsWith('/query')) {
        return Response.json({
          results: [...pages.values()].filter((candidate) => !candidate.in_trash),
          has_more: false,
          next_cursor: null,
        })
      }
      if (method === 'GET' && requestUrl.pathname.startsWith('/v1/pages/')) {
        const found = pages.get(requestUrl.pathname.split('/').pop()!)
        return found
          ? Response.json(found)
          : Response.json({ code: 'object_not_found' }, { status: 404 })
      }
      if (method === 'POST' && requestUrl.pathname === '/v1/pages') {
        created += 1
        const pageId = `page-handler-recreated-${created}`
        const properties = body.properties
        const recreated = notionPage(
          testTodo({
            id: properties['Client ID'].rich_text[0].text.content,
            title: properties.Task.title[0].text.content,
            notionPageId: pageId,
          }),
          pageId,
        )
        pages.set(pageId, recreated)
        return Response.json(recreated)
      }
      return Response.json({ code: 'unhandled' }, { status: 500 })
    })
    const handler = createNotionSyncHandler({
      token: 'secret',
      dataSourceId: 'source-1',
      schema: testSchema,
      fetch: notionFetch as typeof globalThis.fetch,
      dangerouslyAllowUnauthenticated: true,
      dangerouslyAllowEphemeralIdempotency: true,
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'handler-recreate-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage: createMemoryNotionStorage(),
        fetch: (input, init) => handler(new Request(input, init)),
        autoStart: false,
      }),
    )

    await collection.preload()
    const insert = collection.insert(
      testTodo({
        id: 'handler-recreate-1',
        title: 'Before deletion',
      }),
    )
    await insert.isPersisted.promise
    await collection.utils.syncNow()
    const page = [...pages.values()][0]!
    expect(page.properties['Client ID']).toBeDefined()
    const transaction = collection.update('handler-recreate-1', (draft) => {
      draft.title = 'Recreated through handler'
    })
    await transaction.isPersisted.promise
    page.in_trash = true
    await expect(collection.utils.syncNow()).rejects.toMatchObject({
      code: 'page_not_found',
    })
    const [blocked] = await collection.utils.getPendingMutations()

    await collection.utils.resolveDeletedMutation(blocked!.id, {
      action: 'recreate',
    })

    expect(created).toBe(2)
    expect(collection.utils.getSyncState().blockedMutation).toBeNull()
    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    expect(collection.get('handler-recreate-1')?.title).toBe(
      'Recreated through handler',
    )
    await collection.cleanup()
  })

  it('binds the default global fetch before loading a collection', async () => {
    const fetch = vi.fn(function (
      this: typeof globalThis,
      _input: string | URL | Request,
    ) {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation')
      }
      return Promise.resolve(
        Response.json({
          rows: [testTodo({ id: 'default-fetch-row', title: 'Loaded' })],
          hasMore: false,
          nextCursor: null,
        }),
      )
    })
    vi.stubGlobal('fetch', fetch)
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'default-fetch-collection',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage: createMemoryNotionStorage(),
        autoStart: false,
      }),
    )

    await collection.preload()
    await collection.utils.resumeSync()

    expect(collection.get('default-fetch-row')?.title).toBe('Loaded')
    expect(fetch).toHaveBeenCalled()
    await collection.cleanup()
  })

  it('reconciles when a background document becomes visible', async () => {
    const browserWindow = new EventTarget()
    const browserDocument = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    })
    vi.stubGlobal('window', browserWindow)
    vi.stubGlobal('document', browserDocument)

    let remote = testTodo({ id: 'visible-1', title: 'Before focus' })
    const fetch = vi.fn(async () =>
      Response.json({ rows: [remote], hasMore: false, nextCursor: null }),
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'visible-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage: createMemoryNotionStorage(),
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
        readOnly: true,
      }),
    )

    await collection.preload()
    await collection.utils.resumeSync()
    remote = testTodo({ id: 'visible-1', title: 'After focus' })
    browserDocument.dispatchEvent(new Event('visibilitychange'))

    await vi.waitFor(() => {
      expect(collection.get('visible-1')?.title).toBe('After focus')
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    await collection.cleanup()
  })

  it('omits mutation handlers for read-only collections', () => {
    const options = notionCollectionOptions({
      tuning: {
        pollIntervalMs: 0,
      },
      id: 'read-only',
      endpoint: 'http://app.test/api/listening',
      schema: testSchema,
      storage: createMemoryNotionStorage(),
      readOnly: true,
    })

    expect(options).not.toHaveProperty('onInsert')
    expect(options).not.toHaveProperty('onUpdate')
    expect(options).not.toHaveProperty('onDelete')
  })

  it('hydrates without contacting the server until authenticated sync resumes', async () => {
    const cached = testTodo({ id: 'cached-1', title: 'Cached while signed out' })
    const remote = testTodo({ id: 'remote-1', title: 'Loaded after sign in' })
    const storage = createMemoryNotionStorage()
    await storage.save('authenticated-todos', {
      version: 2,
      revision: 0,
      rows: [cached],
      outbox: [],
      lastSyncedAt: 123,
    })
    const fetch = vi.fn(async () =>
      Response.json({ rows: [remote], hasMore: false, nextCursor: null }),
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'authenticated-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()

    expect(fetch).not.toHaveBeenCalled()
    expect(collection.get('cached-1')?.title).toBe('Cached while signed out')
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'idle',
      error: null,
    })

    await collection.utils.resumeSync()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(collection.get('cached-1')).toBeUndefined()
    expect(collection.get('remote-1')?.title).toBe('Loaded after sign in')
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'synced',
      error: null,
    })
    await collection.cleanup()
  })

  it('clears an initial authorization error when sync resumes after login', async () => {
    let authenticated = false
    const fetch = vi.fn(async () => {
      if (!authenticated) {
        return Response.json(
          {
            error: {
              code: 'unauthorized',
              message: 'Authentication is required to sync this collection.',
              retryable: false,
            },
          },
          { status: 401 },
        )
      }
      return Response.json({
        rows: [testTodo({ id: 'signed-in-1', title: 'Authenticated data' })],
        hasMore: false,
        nextCursor: null,
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'login-race-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage: createMemoryNotionStorage(),
        fetch: fetch as typeof globalThis.fetch,
      }),
    )
    await collection.preload()
    await vi.waitFor(() => {
      expect(collection.utils.getSyncState()).toMatchObject({
        status: 'error',
        error: 'Authentication is required to sync this collection.',
      })
    })

    authenticated = true
    await collection.utils.resumeSync()

    expect(collection.get('signed-in-1')?.title).toBe('Authenticated data')
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'synced',
      error: null,
    })
    await collection.cleanup()
  })

  it('keeps mutations durable while automatic sync is paused', async () => {
    const storage = createMemoryNotionStorage()
    const fetch = vi.fn(async () =>
      Response.json({ rows: [], deletedKeys: [], hasMore: false, nextCursor: null }),
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'paused-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )
    await collection.preload()

    const transaction = collection.insert({ id: 'local-1', title: 'Queued locally' })
    await transaction.isPersisted.promise

    expect(fetch).not.toHaveBeenCalled()
    expect(collection.get('local-1')?.title).toBe('Queued locally')
    expect(await collection.utils.getPendingMutations()).toHaveLength(1)
    expect(collection.utils.getSyncState().status).toBe('idle')
    await collection.cleanup()
  })

  it('migrates a valid version-one envelope before acknowledging new work', async () => {
    const cached = testTodo({ id: 'legacy-1', title: 'Legacy cache' })
    let persisted: NotionPersistedEnvelope<typeof cached> | null = {
      version: 1,
      rows: [cached],
      outbox: [],
      lastSyncedAt: 123,
    }
    const storage: NotionCollectionStorage = {
      kind: 'custom',
      async load<TItem extends object>() {
        return persisted as NotionPersistedEnvelope<TItem> | null
      },
      async save<TItem extends object>(
        _collectionId: string,
        state: NotionPersistedState<TItem>,
      ) {
        persisted = state as NotionPersistedState<typeof cached>
      },
      async clear() {
        persisted = null
      },
    }
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'legacy-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )

    await collection.preload()

    expect(collection.get('legacy-1')?.title).toBe('Legacy cache')
    expect(persisted).toMatchObject({ version: 2, revision: 1 })
    await collection.cleanup()
  })

  it('quarantines malformed state and refuses to overwrite it with new work', async () => {
    let persisted: unknown = {
      version: 99,
      rows: [{ id: 'unknown-format' }],
      outbox: [{ important: 'unreadable acknowledged edit' }],
      lastSyncedAt: null,
    }
    let quarantine: NotionQuarantineRecord | null = null
    const storage: NotionCollectionStorage = {
      kind: 'custom',
      async load<TItem extends object>() {
        return persisted as NotionPersistedEnvelope<TItem> | null
      },
      async save() {
        throw new Error('Quarantined state must not be overwritten.')
      },
      async clear() {
        persisted = null
      },
      async quarantine(collectionId, value, reason) {
        quarantine = {
          collectionId,
          value,
          reason,
          quarantinedAt: '2026-08-03T12:00:00.000Z',
        }
        persisted = null
        return quarantine
      },
      async loadQuarantine() {
        return quarantine
      },
      async clearQuarantine() {
        quarantine = null
      },
    }
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'quarantined-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )

    await collection.preload()

    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'error',
      quarantine: {
        reason: 'The persisted collection uses an unknown or invalid storage format.',
      },
    })
    expect((await collection.utils.getQuarantinedState())?.value).toMatchObject({
      version: 99,
    })
    const transaction = collection.insert({ id: 'must-not-write', title: 'Blocked' })
    await expect(transaction.isPersisted.promise).rejects.toThrow(
      'unknown or invalid storage format',
    )
    await collection.cleanup()
  })

  it('surfaces a failed quarantined-state reset instead of silently succeeding', async () => {
    let quarantine: NotionQuarantineRecord | null = {
      collectionId: 'failed-quarantine-reset',
      quarantinedAt: '2026-08-03T12:00:00.000Z',
      reason: 'Malformed persisted state.',
      value: {},
    }
    const storage: NotionCollectionStorage = {
      kind: 'custom',
      async load() {
        return null
      },
      async save() {
        throw new Error('The quarantine reset write failed.')
      },
      async clear() {},
      async loadQuarantine() {
        return quarantine
      },
      async clearQuarantine() {
        quarantine = null
      },
    }
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'failed-quarantine-reset',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )

    await collection.preload()
    await expect(
      collection.utils.discardQuarantinedState({ acceptDataLoss: true }),
    ).rejects.toThrow('The quarantine reset write failed.')
    await collection.cleanup()
  })

  it('hydrates cached rows while offline', async () => {
    const storage = createMemoryNotionStorage()
    const cached = testTodo({ id: 'cached-1', title: 'Available offline' })
    await storage.save('cached-todos', {
      version: 2,
      revision: 0,
      rows: [cached],
      outbox: [],
      lastSyncedAt: 123,
    })

    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'cached-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )

    await collection.preload()
    expect(collection.get('cached-1')).toMatchObject(cached)
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'offline',
      lastSyncedAt: 123,
      storage: 'memory',
    })
    await collection.cleanup()
  })

  it('preserves acknowledged edits from two collection instances sharing storage', async () => {
    const storage = createMemoryNotionStorage()
    const createTodos = () =>
      createCollection(
        notionCollectionOptions({
          tuning: {
            isOnline: () => false,
            pollIntervalMs: 0,
            coordinationStrategy: 'storage-lease',
          },
          id: 'multi-context-todos',
          endpoint: 'http://app.test/api/todos',
          schema: testSchema,
          storage,
          fetch: vi.fn() as typeof fetch,
        }),
      )
    const first = createTodos()
    const second = createTodos()
    await Promise.all([first.preload(), second.preload()])

    const firstWrite = first.insert({ id: 'tab-a', title: 'Written in tab A' })
    const secondWrite = second.insert({ id: 'tab-b', title: 'Written in tab B' })
    await Promise.all([
      firstWrite.isPersisted.promise,
      secondWrite.isPersisted.promise,
    ])

    const persisted = await storage.load<ReturnType<typeof testTodo>>(
      'multi-context-todos',
    )
    expect(persisted).toMatchObject({ version: 2, revision: 2 })
    expect(persisted?.rows.map((row) => row.id).sort()).toEqual([
      'tab-a',
      'tab-b',
    ])
    expect(persisted?.outbox).toHaveLength(2)

    await Promise.all([first.cleanup(), second.cleanup()])
    const afterReload = createTodos()
    await afterReload.preload()
    expect(afterReload.get('tab-a')?.title).toBe('Written in tab A')
    expect(afterReload.get('tab-b')?.title).toBe('Written in tab B')
    expect(afterReload.utils.getSyncState().pendingMutations).toBe(2)
    await afterReload.cleanup()
  })

  it('uses a webhook invalidation version to avoid unnecessary Notion refreshes', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    let version = 0
    let title = 'Initial remote value'
    let listRequests = 0
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.searchParams.get('action') === 'version') {
        return Response.json({ version })
      }
      listRequests += 1
      return Response.json({
        rows: [testTodo({ id: 'versioned', title })],
        hasMore: false,
        nextCursor: null,
        version,
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'versioned-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    isOnline = true
    await collection.utils.syncNow()
    expect(collection.get('versioned')?.title).toBe('Initial remote value')
    expect(collection.utils.getSyncState().remoteVersion).toBe(0)
    expect(await collection.utils.checkForRemoteChanges()).toBe(false)
    expect(listRequests).toBe(1)

    version = 1
    title = 'Changed in Notion'
    expect(await collection.utils.checkForRemoteChanges()).toBe(true)
    expect(collection.get('versioned')?.title).toBe('Changed in Notion')
    expect(collection.utils.getSyncState().remoteVersion).toBe(1)
    expect(listRequests).toBe(2)
    expect(await storage.load('versioned-todos')).toMatchObject({
      remoteVersion: 1,
    })
    await collection.cleanup()
  })

  it('acknowledges its own contiguous mutation without rereading the collection', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    let version = 0
    let listRequests = 0
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const created = testTodo({
            id: 'causal-write',
            title: 'Acknowledged by Notion',
            notionPageId: 'page-causal-write',
          })
          const versionBefore = version
          version += 1
          return Response.json({
            rows: [created],
            deletedKeys: [],
            invalidation: { versionBefore, versionAfter: version },
          })
        }
        listRequests += 1
        return Response.json({
          rows: [],
          hasMore: false,
          nextCursor: null,
          version,
        })
      },
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'causal-write-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    isOnline = true
    await collection.utils.syncNow()
    const transaction = collection.insert({
      id: 'causal-write',
      title: 'Local title',
    })
    await transaction.isPersisted.promise
    await vi.waitFor(() => {
      expect(collection.utils.getSyncState().pendingMutations).toBe(0)
    })

    expect(listRequests).toBe(1)
    expect(collection.get('causal-write')).toMatchObject({
      title: 'Acknowledged by Notion',
      notionPageId: 'page-causal-write',
    })
    expect(collection.utils.getSyncState().remoteVersion).toBe(1)
    expect(await storage.load('causal-write-todos')).toMatchObject({
      remoteVersion: 1,
    })
    await collection.cleanup()
  })

  it('reconciles when another invalidation interleaves with a mutation', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    let listRequests = 0
    const acknowledged = testTodo({
      id: 'interleaved-write',
      title: 'Acknowledged write',
      notionPageId: 'page-interleaved-write',
    })
    const concurrent = testTodo({
      id: 'concurrent-remote',
      title: 'Changed concurrently',
      notionPageId: 'page-concurrent-remote',
    })
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Response.json({
            rows: [acknowledged],
            deletedKeys: [],
            invalidation: { versionBefore: 0, versionAfter: 2 },
          })
        }
        listRequests += 1
        return Response.json({
          rows: listRequests === 1 ? [] : [acknowledged, concurrent],
          hasMore: false,
          nextCursor: null,
          version: listRequests === 1 ? 0 : 2,
        })
      },
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'interleaved-write-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    isOnline = true
    await collection.utils.syncNow()
    const transaction = collection.insert({
      id: 'interleaved-write',
      title: 'Local write',
    })
    await transaction.isPersisted.promise
    await vi.waitFor(() => {
      expect(collection.utils.getSyncState()).toMatchObject({
        pendingMutations: 0,
        remoteVersion: 2,
      })
    })

    expect(listRequests).toBe(2)
    expect(collection.get('concurrent-remote')?.title).toBe(
      'Changed concurrently',
    )
    await collection.cleanup()
  })

  it('merges incremental changes and reserves deletion cleanup for a full sync', async () => {
    const storage = createMemoryNotionStorage()
    const watermark = '2026-08-01T12:00:00.000Z'
    const unchanged = testTodo({
      id: 'unchanged',
      title: 'Keep unchanged',
      updatedAt: watermark,
    })
    const staleDeleted = testTodo({
      id: 'deleted-remotely',
      title: 'Await full reconciliation',
      updatedAt: watermark,
    })
    await storage.save('incremental-todos', {
      version: 2,
      revision: 0,
      rows: [unchanged, staleDeleted],
      outbox: [],
      lastSyncedAt: Date.now(),
      lastFullReconciledAt: Date.now(),
      remoteWatermark: watermark,
      remoteVersion: 0,
    })
    const changed = testTodo({
      id: 'changed',
      title: 'Fetched incrementally',
      updatedAt: '2026-08-02T12:00:00.000Z',
    })
    const listUrls: Array<URL> = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.searchParams.get('action') === 'version') {
        return Response.json({ version: 1 })
      }
      listUrls.push(url)
      return url.searchParams.has('editedAfter')
        ? Response.json({
            rows: [changed],
            hasMore: false,
            nextCursor: null,
            watermark: changed.updatedAt,
            version: 1,
          })
        : Response.json({
            rows: [unchanged, changed],
            hasMore: false,
            nextCursor: null,
            watermark: changed.updatedAt,
            version: 1,
          })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
          fullReconciliationIntervalMs: 60 * 60_000,
        },
        id: 'incremental-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()
    expect(await collection.utils.checkForRemoteChanges()).toBe(true)

    expect(listUrls).toHaveLength(1)
    expect(listUrls[0]?.searchParams.get('editedAfter')).toBe(watermark)
    expect(collection.get('unchanged')?.title).toBe('Keep unchanged')
    expect(collection.get('changed')?.title).toBe('Fetched incrementally')
    expect(collection.get('deleted-remotely')).toBeDefined()

    await collection.utils.syncNow()

    expect(listUrls).toHaveLength(2)
    expect(listUrls[1]?.searchParams.has('editedAfter')).toBe(false)
    expect(collection.get('deleted-remotely')).toBeUndefined()
    expect(await storage.load('incremental-todos')).toMatchObject({
      remoteWatermark: changed.updatedAt,
      remoteVersion: 1,
    })
    await collection.cleanup()
  })

  it('uses a full snapshot when periodic reconciliation is due', async () => {
    const storage = createMemoryNotionStorage()
    const watermark = '2026-08-01T12:00:00.000Z'
    await storage.save('due-full-todos', {
      version: 2,
      revision: 0,
      rows: [testTodo({ id: 'stale' })],
      outbox: [],
      lastSyncedAt: 1,
      lastFullReconciledAt: 1,
      remoteWatermark: watermark,
      remoteVersion: 0,
    })
    const listUrls: Array<URL> = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.searchParams.get('action') === 'version') {
        return Response.json({ version: 1 })
      }
      listUrls.push(url)
      return Response.json({
        rows: [],
        hasMore: false,
        nextCursor: null,
        version: 1,
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
          fullReconciliationIntervalMs: 100,
        },
        id: 'due-full-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()
    expect(await collection.utils.checkForRemoteChanges()).toBe(true)

    expect(listUrls).toHaveLength(1)
    expect(listUrls[0]?.searchParams.has('editedAfter')).toBe(false)
    expect(collection.get('stale')).toBeUndefined()
    await collection.cleanup()
  })

  it('materializes every remote page before committing a read-only refresh', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    const first = testTodo({ id: 'page-one', title: 'First page' })
    const second = testTodo({ id: 'page-two', title: 'Second page' })
    const requests: Array<URL> = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      requests.push(url)
      return url.searchParams.get('cursor') === 'cursor-2'
        ? Response.json({ rows: [second], hasMore: false, nextCursor: null })
        : Response.json({
            rows: [first],
            hasMore: true,
            nextCursor: 'cursor-2',
          })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pageSize: 20,
          pollIntervalMs: 0,
        },
        id: 'paginated-read-only',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        readOnly: true,
      }),
    )

    await collection.preload()
    isOnline = true
    await collection.utils.syncNow()

    expect(collection.get('page-one')?.title).toBe('First page')
    expect(collection.get('page-two')?.title).toBe('Second page')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.searchParams.get('pageSize')).toBe('20')
    expect(requests[1]?.searchParams.get('cursor')).toBe('cursor-2')
    await collection.cleanup()
  })

  it('publishes additive pages during a mutable collection bootstrap', async () => {
    const storage = createMemoryNotionStorage()
    const first = testTodo({ id: 'bootstrap-one', title: 'First visible page' })
    const second = testTodo({ id: 'bootstrap-two', title: 'Final page' })
    let resolveSecond!: (response: Response) => void
    const secondResponse = new Promise<Response>((resolve) => {
      resolveSecond = resolve
    })
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      return url.searchParams.has('cursor')
        ? secondResponse
        : Response.json({
            rows: [first],
            hasMore: true,
            nextCursor: 'bootstrap-cursor',
            watermark: first.updatedAt,
          })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'mutable-bootstrap',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()
    const synchronization = collection.utils.syncNow()
    await vi.waitFor(() => {
      expect(collection.get('bootstrap-one')?.title).toBe('First visible page')
    })

    expect(collection.get('bootstrap-two')).toBeUndefined()
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'syncing',
      progress: { phase: 'pull', loadedPages: 1, loadedRows: 1 },
      lastSyncedAt: null,
    })
    expect(await storage.load('mutable-bootstrap')).toMatchObject({
      rows: [{ id: 'bootstrap-one' }],
      lastSyncedAt: null,
    })

    resolveSecond(
      Response.json({
        rows: [second],
        hasMore: false,
        nextCursor: null,
        watermark: second.updatedAt,
      }),
    )
    await synchronization

    expect(collection.get('bootstrap-one')).toBeDefined()
    expect(collection.get('bootstrap-two')).toBeDefined()
    expect(collection.utils.getSyncState().progress).toBeNull()
    expect(collection.utils.getSyncState().lastSyncedAt).not.toBeNull()
    await collection.cleanup()
  })

  it('retains a partial bootstrap after a later page fails and safely retries', async () => {
    const storage = createMemoryNotionStorage()
    const first = testTodo({ id: 'durable-bootstrap-one' })
    const second = testTodo({ id: 'durable-bootstrap-two' })
    let failSecondPage = true
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (!url.searchParams.has('cursor')) {
        return Response.json({
          rows: [first],
          hasMore: true,
          nextCursor: 'durable-bootstrap-cursor',
          watermark: first.updatedAt,
        })
      }
      if (failSecondPage) {
        return Response.json(
          {
            error: {
              code: 'temporary_failure',
              message: 'The second page failed.',
              retryable: true,
            },
          },
          { status: 503 },
        )
      }
      return Response.json({
        rows: [second],
        hasMore: false,
        nextCursor: null,
        watermark: second.updatedAt,
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'durable-mutable-bootstrap',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()
    await expect(collection.utils.syncNow()).rejects.toThrow(
      'The second page failed.',
    )

    expect(collection.get('durable-bootstrap-one')).toBeDefined()
    expect(await storage.load('durable-mutable-bootstrap')).toMatchObject({
      rows: [{ id: 'durable-bootstrap-one' }],
      lastSyncedAt: null,
    })

    failSecondPage = false
    await collection.utils.syncNow()

    expect(collection.get('durable-bootstrap-one')).toBeDefined()
    expect(collection.get('durable-bootstrap-two')).toBeDefined()
    expect(collection.utils.getSyncState().lastSyncedAt).not.toBeNull()
    await collection.cleanup()
  })

  it('retains the last complete snapshot when a later remote page fails', async () => {
    const storage = createMemoryNotionStorage()
    const cached = testTodo({ id: 'last-good', title: 'Last complete snapshot' })
    await storage.save('atomic-refresh-todos', {
      version: 2,
      revision: 0,
      rows: [cached],
      outbox: [],
      lastSyncedAt: 123,
    })
    let isOnline = false
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.searchParams.has('cursor')) {
        throw new TypeError('The second page disappeared.')
      }
      return Response.json({
        rows: [testTodo({ id: 'partial', title: 'Uncommitted first page' })],
        hasMore: true,
        nextCursor: 'page-2',
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'atomic-refresh-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        readOnly: true,
      }),
    )

    await collection.preload()
    isOnline = true
    await expect(collection.utils.syncNow()).rejects.toThrow(
      'The second page disappeared.',
    )

    expect(collection.get('last-good')?.title).toBe('Last complete snapshot')
    expect(collection.get('partial')).toBeUndefined()
    expect(await storage.load('atomic-refresh-todos')).toMatchObject({
      revision: 0,
      rows: [{ id: 'last-good' }],
      lastSyncedAt: 123,
    })
    await collection.cleanup()
  })

  it('checkpoints progressive pages and hydrates the loaded window offline', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    const first = testTodo({ id: 'progressive-one', title: 'First page' })
    const second = testTodo({ id: 'progressive-two', title: 'Second page' })
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      return url.searchParams.get('cursor') === 'cursor-2'
        ? Response.json({ rows: [second], hasMore: false, nextCursor: null })
        : Response.json({
            rows: [first],
            hasMore: true,
            nextCursor: 'cursor-2',
          })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pageSize: 1,
          pollIntervalMs: 0,
        },
        id: 'progressive-read-only',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        readOnly: true,
        syncMode: 'progressive',
      }),
    )

    await collection.preload()
    isOnline = true
    await collection.utils.syncNow()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(collection.get('progressive-one')?.title).toBe('First page')
    expect(collection.get('progressive-two')).toBeUndefined()
    expect(collection.utils.getPaginationState()).toEqual({
      mode: 'progressive',
      loadedPages: 1,
      nextCursor: 'cursor-2',
      hasMore: true,
    })

    await collection.utils.loadMore()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(collection.get('progressive-two')?.title).toBe('Second page')
    expect(collection.utils.getPaginationState()).toEqual({
      mode: 'progressive',
      loadedPages: 2,
      nextCursor: null,
      hasMore: false,
    })
    await collection.cleanup()

    const offlineCollection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'progressive-read-only',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof globalThis.fetch,
        readOnly: true,
        syncMode: 'progressive',
      }),
    )
    await offlineCollection.preload()

    expect(offlineCollection.get('progressive-one')?.title).toBe('First page')
    expect(offlineCollection.get('progressive-two')?.title).toBe('Second page')
    expect(offlineCollection.utils.getPaginationState()?.loadedPages).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    await offlineCollection.cleanup()
  })

  it('rejects progressive sync for mutable collections', () => {
    expect(() =>
      notionCollectionOptions({
        id: 'invalid-progressive',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage: createMemoryNotionStorage(),
        syncMode: 'progressive',
      }),
    ).toThrow('Progressive sync requires a read-only collection.')
  })

  it('rebuilds the entire loaded window during a progressive refresh', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    let remoteVersion = 1
    const first = testTodo({ id: 'old-one', title: 'Old first page' })
    const second = testTodo({ id: 'old-two', title: 'Old second page' })
    const replacement = testTodo({ id: 'new-one', title: 'New first page' })
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      const isSecondPage = url.searchParams.has('cursor')
      if (remoteVersion === 2) {
        return isSecondPage
          ? Response.json({ rows: [], hasMore: false, nextCursor: null })
          : Response.json({
              rows: [replacement],
              hasMore: true,
              nextCursor: 'new-cursor-2',
            })
      }
      return isSecondPage
        ? Response.json({ rows: [second], hasMore: false, nextCursor: null })
        : Response.json({
            rows: [first],
            hasMore: true,
            nextCursor: 'old-cursor-2',
          })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pageSize: 1,
          pollIntervalMs: 0,
        },
        id: 'progressive-window-refresh',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        readOnly: true,
        syncMode: 'progressive',
      }),
    )

    await collection.preload()
    isOnline = true
    await collection.utils.syncNow()
    await collection.utils.loadMore()
    expect(collection.size).toBe(2)

    remoteVersion = 2
    await collection.utils.syncNow()

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(collection.get('old-one')).toBeUndefined()
    expect(collection.get('old-two')).toBeUndefined()
    expect(collection.get('new-one')?.title).toBe('New first page')
    expect(collection.utils.getPaginationState()).toEqual({
      mode: 'progressive',
      loadedPages: 2,
      nextCursor: null,
      hasMore: false,
    })
    await collection.cleanup()
  })

  it('durably queues offline writes and flushes them when online', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    const remote = testTodo({
      id: 'local-1',
      title: 'Created offline',
      notionPageId: 'page-1',
      notionUrl: 'https://notion.so/page-1',
    })
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json({ rows: [remote], deletedKeys: [] })
      }
      return Response.json({ rows: [remote], hasMore: false, nextCursor: null })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'offline-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({
      id: 'local-1',
      title: 'Created offline',
      priority: 'High',
    })
    await transaction.isPersisted.promise

    expect(collection.get('local-1')).toMatchObject({
      title: 'Created offline',
      notionPageId: null,
    })
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'offline',
      pendingMutations: 1,
    })
    const persisted = await storage.load('offline-todos')
    expect(persisted?.outbox).toHaveLength(1)

    isOnline = true
    await collection.utils.syncNow()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(collection.get('local-1')).toMatchObject({
      notionPageId: 'page-1',
      notionUrl: 'https://notion.so/page-1',
    })
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'synced',
      pendingMutations: 0,
    })
    expect((await storage.load('offline-todos'))?.outbox).toHaveLength(0)
    await collection.cleanup()
  })

  it('keeps queued writes when the server rejects a retry', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'retry-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({ id: 'retry-1', title: 'Keep me' })
    await transaction.isPersisted.promise
    isOnline = true

    await expect(collection.utils.syncNow()).rejects.toThrow('Failed to fetch')
    expect(collection.utils.getSyncState()).toMatchObject({
      status: 'error',
      pendingMutations: 1,
      blockedMutation: null,
    })
    expect(await collection.utils.getPendingMutations()).toMatchObject([
      {
        attempts: 1,
        lastError: {
          code: 'network_error',
          retryable: true,
        },
      },
    ])
    expect(collection.get('retry-1')?.title).toBe('Keep me')
    await collection.cleanup()
  })

  it('keeps the original durable entry when recording a delivery failure also fails', async () => {
    const backingStorage = createMemoryNotionStorage()
    let failSaves = false
    const storage: NotionCollectionStorage = {
      kind: 'custom',
      load: backingStorage.load,
      clear: backingStorage.clear,
      async save(collectionId, state) {
        if (failSaves) throw new Error('Could not record the attempt.')
        await backingStorage.save(collectionId, state)
      },
    }
    let isOnline = false
    const fetch = vi.fn(async () => {
      throw new TypeError('The delivery failed.')
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'failed-attempt-checkpoint',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({
      id: 'still-durable',
      title: 'Keep the original entry',
    })
    await transaction.isPersisted.promise
    const before = await backingStorage.load('failed-attempt-checkpoint')

    failSaves = true
    isOnline = true
    await expect(collection.utils.syncNow()).rejects.toThrow(
      'Could not record the attempt.',
    )

    const after = await backingStorage.load('failed-attempt-checkpoint')
    expect(after).toEqual(before)
    expect(after?.outbox).toHaveLength(1)
    expect(collection.get('still-durable')?.title).toBe(
      'Keep the original entry',
    )
    await collection.cleanup()
  })

  it('retains structured property conflicts on the poison outbox entry', async () => {
    const storage = createMemoryNotionStorage()
    const original = testTodo({ id: 'conflict-1', title: 'Original' })
    await storage.save('conflict-todos', {
      version: 2,
      revision: 0,
      rows: [original],
      outbox: [],
      lastSyncedAt: null,
    })
    let isOnline = false
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'property_conflict',
            message: 'The title changed remotely.',
            retryable: false,
            conflicts: [
              {
                field: 'title',
                baseValue: 'Original',
                localValue: 'Local',
                remoteValue: 'Remote',
              },
            ],
          },
        },
        { status: 409 },
      ),
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'conflict-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )
    await collection.preload()
    const transaction = collection.update('conflict-1', (draft) => {
      draft.title = 'Local'
    })
    await transaction.isPersisted.promise
    isOnline = true

    await expect(collection.utils.syncNow()).rejects.toMatchObject({
      code: 'property_conflict',
      conflicts: [{ field: 'title' }],
    })
    expect((await collection.utils.getPendingMutations())[0]?.lastError).toMatchObject({
      code: 'property_conflict',
      conflicts: [{ field: 'title', remoteValue: 'Remote' }],
    })
    await collection.cleanup()
  })

  it('records a rejected entry and retries it explicitly', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    let rejectWrite = true
    const remote = testTodo({
      id: 'recover-1',
      title: 'Recover me',
      notionPageId: 'page-recover-1',
    })
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && rejectWrite) {
        return Response.json(
          {
            error: {
              code: 'schema_mismatch',
              message: 'The schema changed.',
              retryable: false,
            },
          },
          { status: 422 },
        )
      }
      return init?.method === 'POST'
        ? Response.json({ rows: [remote], deletedKeys: [] })
        : Response.json({ rows: [remote], hasMore: false, nextCursor: null })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'recover-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({ id: 'recover-1', title: 'Recover me' })
    await transaction.isPersisted.promise
    isOnline = true
    await expect(collection.utils.syncNow()).rejects.toThrow('The schema changed.')

    const [failed] = await collection.utils.getPendingMutations()
    expect(failed).toMatchObject({
      attempts: 1,
      lastError: { code: 'schema_mismatch', status: 422, retryable: false },
    })
    expect(collection.utils.getSyncState()).toMatchObject({
      blockedMutation: {
        entryId: failed!.id,
        error: {
          code: 'schema_mismatch',
          status: 422,
          retryable: false,
        },
      },
    })

    rejectWrite = false
    await collection.utils.retryPendingMutation(failed!.id)
    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    expect(collection.utils.getSyncState().blockedMutation).toBeNull()
    expect(collection.get('recover-1')?.notionPageId).toBe('page-recover-1')
    await collection.cleanup()
  })

  it('recreates a remotely deleted row from a blocked local update', async () => {
    const storage = createMemoryNotionStorage()
    let recreate = false
    let remoteTitle = 'Before deletion'
    const remote = testTodo({
      id: 'deleted-recover-1',
      title: 'Before deletion',
      notionPageId: 'page-deleted-recover-1',
    })
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && !recreate) {
        return Response.json(
          {
            error: {
              code: 'page_not_found',
              message: 'The Notion page could not be found.',
              retryable: false,
            },
          },
          { status: 404 },
        )
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          mutations: Array<{ type: string; value: TestTodo }>
        }
        expect(body.mutations[0]?.type).toBe('insert')
        remoteTitle = body.mutations[0]!.value.title
        return Response.json({
          rows: [{ ...remote, title: remoteTitle }],
          deletedKeys: [],
        })
      }
      return Response.json({
        rows: [{ ...remote, title: remoteTitle }],
        hasMore: false,
        nextCursor: null,
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'deleted-recover-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()
    await collection.utils.syncNow()
    const transaction = collection.update('deleted-recover-1', (draft) => {
      draft.title = 'Recreated locally'
    })
    await transaction.isPersisted.promise
    await expect(collection.utils.syncNow()).rejects.toMatchObject({
      code: 'page_not_found',
    })
    const [failed] = await collection.utils.getPendingMutations()
    expect(collection.utils.getSyncState().blockedMutation).toMatchObject({
      entryId: failed!.id,
      error: { code: 'page_not_found', status: 404 },
    })

    recreate = true
    await collection.utils.resolveDeletedMutation(failed!.id, {
      action: 'recreate',
    })

    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    expect(collection.get('deleted-recover-1')?.title).toBe('Recreated locally')
    expect(collection.get('deleted-recover-1')?.notionPageId).toBe(
      'page-deleted-recover-1',
    )
    await collection.cleanup()
  })

  it('drops a remotely deleted row only with explicit data-loss acknowledgement', async () => {
    const storage = createMemoryNotionStorage()
    let initialPull = true
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json(
          {
            error: {
              code: 'page_not_found',
              message: 'The Notion page could not be found.',
              retryable: false,
            },
          },
          { status: 404 },
        )
      }
      const rows = initialPull
        ? [
            testTodo({
              id: 'deleted-discard-1',
              notionPageId: 'page-deleted-discard-1',
            }),
          ]
        : []
      initialPull = false
      return Response.json({ rows, hasMore: false, nextCursor: null })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 0,
        },
        id: 'deleted-discard-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )

    await collection.preload()
    await collection.utils.syncNow()
    const transaction = collection.update('deleted-discard-1', (draft) => {
      draft.title = 'Discard this edit'
    })
    await transaction.isPersisted.promise
    await expect(collection.utils.syncNow()).rejects.toMatchObject({
      code: 'page_not_found',
    })
    const [failed] = await collection.utils.getPendingMutations()

    await expect(
      collection.utils.resolveDeletedMutation(failed!.id, {
        action: 'discard',
      } as never),
    ).rejects.toMatchObject({ code: 'data_loss_not_accepted' })
    await collection.utils.resolveDeletedMutation(failed!.id, {
      action: 'discard',
      acceptDataLoss: true,
    })

    expect(collection.get('deleted-discard-1')).toBeUndefined()
    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    await collection.cleanup()
  })

  it('requires an online, explicit data-loss acknowledgement to discard an entry', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json(
          {
            error: {
              code: 'invalid_mutation',
              message: 'The mutation cannot be applied.',
              retryable: false,
            },
          },
          { status: 400 },
        )
      }
      return Response.json({ rows: [], hasMore: false, nextCursor: null })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'discard-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({ id: 'discard-1', title: 'Discard me' })
    await transaction.isPersisted.promise
    const [pending] = await collection.utils.getPendingMutations()

    await expect(
      collection.utils.discardPendingMutation(pending!.id, {
        acceptDataLoss: true,
      }),
    ).rejects.toMatchObject({ code: 'discard_requires_online' })

    isOnline = true
    await collection.utils.discardPendingMutation(pending!.id, {
      acceptDataLoss: true,
    })
    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    expect(collection.utils.getSyncState().blockedMutation).toBeNull()
    expect(collection.get('discard-1')).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    await collection.cleanup()
  })

  it('does not publish a mutation when durable queue persistence fails', async () => {
    const backingStorage = createMemoryNotionStorage()
    const storage: NotionCollectionStorage = {
      kind: 'custom',
      load: backingStorage.load,
      clear: backingStorage.clear,
      async save() {
        throw new Error('The durable write failed.')
      },
    }
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'failed-write-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({
      id: 'not-durable',
      title: 'Must roll back',
    })

    await expect(transaction.isPersisted.promise).rejects.toThrow(
      'The durable write failed.',
    )
    await vi.waitFor(() => expect(collection.get('not-durable')).toBeUndefined())
    expect(await backingStorage.load('failed-write-todos')).toBeNull()
    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    await collection.cleanup()
  })

  it('does not let a sync-state subscriber break durable acknowledgement', async () => {
    const storage = createMemoryNotionStorage()
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'observer-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )
    await collection.preload()
    const unsubscribe = collection.utils.subscribeSyncState(() => {
      throw new Error('Rendering observer failed.')
    })

    const transaction = collection.insert({ id: 'observer-1', title: 'Durable' })
    await transaction.isPersisted.promise
    expect((await storage.load('observer-todos'))?.outbox).toHaveLength(1)

    unsubscribe()
    await collection.cleanup()
  })

  it('keeps the durable outbox entry when checkpointing an acknowledgement fails', async () => {
    const backingStorage = createMemoryNotionStorage()
    let failSaves = false
    const storage: NotionCollectionStorage = {
      kind: 'custom',
      load: backingStorage.load,
      clear: backingStorage.clear,
      async save(collectionId, state) {
        if (failSaves) throw new Error('Checkpoint failed.')
        await backingStorage.save(collectionId, state)
      },
    }
    let isOnline = false
    const remote = testTodo({
      id: 'checkpoint-1',
      title: 'Durable before remote',
      notionPageId: 'page-checkpoint-1',
    })
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json({ rows: [remote], deletedKeys: [] })
        : Response.json({ rows: [remote], hasMore: false, nextCursor: null }),
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'checkpoint-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const transaction = collection.insert({
      id: 'checkpoint-1',
      title: 'Durable before remote',
    })
    await transaction.isPersisted.promise

    failSaves = true
    isOnline = true
    await expect(collection.utils.syncNow()).rejects.toThrow('Checkpoint failed.')

    expect(collection.utils.getSyncState().pendingMutations).toBe(1)
    expect((await backingStorage.load('checkpoint-todos'))?.outbox).toHaveLength(1)
    expect(collection.get('checkpoint-1')?.title).toBe('Durable before remote')

    failSaves = false
    await collection.utils.syncNow()
    expect(collection.utils.getSyncState().pendingMutations).toBe(0)
    expect((await backingStorage.load('checkpoint-todos'))?.outbox).toHaveLength(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    await collection.cleanup()
  })

  it('flushes in FIFO order and keeps later pending values visible', async () => {
    const storage = createMemoryNotionStorage()
    const original = testTodo({ id: 'ordered-1', title: 'Original' })
    await storage.save('ordered-todos', {
      version: 2,
      revision: 0,
      rows: [original],
      outbox: [],
      lastSyncedAt: null,
    })
    let isOnline = false
    const sentTitles: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        return Response.json({ rows: [], hasMore: false, nextCursor: null })
      }
      const body = JSON.parse(String(init.body)) as {
        mutations: Array<{ value?: { title?: string } }>
      }
      sentTitles.push(body.mutations[0]?.value?.title ?? '')
      if (sentTitles.length === 2) throw new TypeError('Second write is offline')
      return Response.json({
        rows: [testTodo({ id: 'ordered-1', title: 'First edit' })],
        deletedKeys: [],
      })
    })
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'ordered-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )

    await collection.preload()
    const first = collection.update('ordered-1', (draft) => {
      draft.title = 'First edit'
    })
    await first.isPersisted.promise
    const second = collection.update('ordered-1', (draft) => {
      draft.title = 'Second edit'
    })
    await second.isPersisted.promise

    isOnline = true
    await expect(collection.utils.syncNow()).rejects.toThrow(
      'Second write is offline',
    )

    expect(sentTitles).toEqual(['First edit', 'Second edit'])
    expect(collection.get('ordered-1')?.title).toBe('Second edit')
    expect(collection.utils.getSyncState().pendingMutations).toBe(1)
    expect((await storage.load('ordered-todos'))?.outbox).toHaveLength(1)
    await collection.cleanup()
  })

  it('chunks large TanStack transactions into bounded outbox batches', async () => {
    const storage = createMemoryNotionStorage()
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => false,
          pollIntervalMs: 0,
        },
        id: 'bulk-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof fetch,
      }),
    )
    await collection.preload()

    const items = Array.from({ length: 51 }, (_, index) => ({
      id: `bulk-${index + 1}`,
      title: `Bulk item ${index + 1}`,
    }))
    const transaction = collection.insert(items)
    await transaction.isPersisted.promise

    const persisted = await storage.load('bulk-todos')
    expect(persisted?.rows).toHaveLength(51)
    expect(persisted?.outbox).toHaveLength(6)
    expect(persisted?.outbox.map((entry) => entry.batch.mutations.length)).toEqual([
      10, 10, 10, 10, 10, 1,
    ])
    expect(new Set(persisted?.outbox.map((entry) => entry.batch.idempotencyKey)).size)
      .toBe(6)
    await collection.cleanup()
  })

  it('reports mutation progress as bounded batches drain', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = false
    const sentBatchSizes: Array<number> = []
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as {
            mutations: Array<{ value: ReturnType<typeof testTodo> }>
          }
          sentBatchSizes.push(body.mutations.length)
          return Response.json({
            rows: body.mutations.map(({ value }, index) => ({
              ...value,
              notionPageId: `progress-page-${sentBatchSizes.length}-${index}`,
            })),
            deletedKeys: [],
          })
        }
        return Response.json({ rows: [], hasMore: false, nextCursor: null })
      },
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => isOnline,
          pollIntervalMs: 0,
        },
        id: 'progress-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        autoStart: false,
      }),
    )
    await collection.preload()
    const transaction = collection.insert(
      Array.from({ length: 25 }, (_, index) => ({
        id: `progress-${index}`,
        title: `Progress ${index}`,
      })),
    )
    await transaction.isPersisted.promise

    const progress: Array<NonNullable<ReturnType<
      typeof collection.utils.getSyncState
    >['progress']>> = []
    const unsubscribe = collection.utils.subscribeSyncState(() => {
      const current = collection.utils.getSyncState().progress
      if (current?.phase === 'push') progress.push(current)
    })
    isOnline = true
    await collection.utils.syncNow()

    expect(sentBatchSizes).toEqual([10, 10, 5])
    expect(progress).toEqual(
      expect.arrayContaining([
        {
          phase: 'push',
          completedMutations: 0,
          totalMutations: 25,
          activeBatchMutations: 10,
        },
        {
          phase: 'push',
          completedMutations: 10,
          totalMutations: 25,
          activeBatchMutations: 10,
        },
        {
          phase: 'push',
          completedMutations: 20,
          totalMutations: 25,
          activeBatchMutations: 5,
        },
        {
          phase: 'push',
          completedMutations: 25,
          totalMutations: 25,
          activeBatchMutations: 0,
        },
      ]),
    )
    expect(collection.utils.getSyncState().progress).toBeNull()

    unsubscribe()
    await collection.cleanup()
  })

  it('aborts in-flight synchronization and prevents later writes during cleanup', async () => {
    const storage = createMemoryNotionStorage()
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined
          requestSignal?.addEventListener(
            'abort',
            () => reject(requestSignal?.reason),
            { once: true },
          )
        }),
    )
    const collection = createCollection(
      notionCollectionOptions({
        tuning: {
          isOnline: () => true,
          pollIntervalMs: 10,
        },
        id: 'cleanup-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
      }),
    )
    await collection.preload()
    await vi.waitFor(() => expect(requestSignal).toBeDefined())

    await collection.cleanup()

    expect(requestSignal?.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await storage.load('cleanup-todos')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
