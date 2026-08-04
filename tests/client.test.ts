import { createCollection } from '@tanstack/db'
import { describe, expect, it, vi } from 'vitest'
import {
  createMemoryNotionStorage,
  notionCollectionOptions,
  type NotionCollectionStorage,
  type NotionPersistedEnvelope,
  type NotionPersistedState,
  type NotionQuarantineRecord,
} from '../src/index.js'
import { testSchema, testTodo } from './fixtures.js'

describe('notionCollectionOptions', () => {
  it('omits mutation handlers for read-only collections', () => {
    const options = notionCollectionOptions({
      id: 'read-only',
      endpoint: 'http://app.test/api/listening',
      schema: testSchema,
      storage: createMemoryNotionStorage(),
      readOnly: true,
      pollIntervalMs: 0,
    })

    expect(options).not.toHaveProperty('onInsert')
    expect(options).not.toHaveProperty('onUpdate')
    expect(options).not.toHaveProperty('onDelete')
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
        id: 'legacy-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => false,
        fetch: vi.fn() as typeof fetch,
        pollIntervalMs: 0,
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
        id: 'quarantined-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => false,
        fetch: vi.fn() as typeof fetch,
        pollIntervalMs: 0,
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
        id: 'cached-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => false,
        fetch: vi.fn() as typeof fetch,
        pollIntervalMs: 0,
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
          id: 'multi-context-todos',
          endpoint: 'http://app.test/api/todos',
          schema: testSchema,
          storage,
          isOnline: () => false,
          fetch: vi.fn() as typeof fetch,
          pollIntervalMs: 0,
          coordinationStrategy: 'storage-lease',
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
        id: 'versioned-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        pollIntervalMs: 0,
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
        id: 'paginated-read-only',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        pageSize: 20,
        pollIntervalMs: 0,
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
        id: 'atomic-refresh-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        pollIntervalMs: 0,
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
        id: 'progressive-read-only',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        pageSize: 1,
        pollIntervalMs: 0,
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
        id: 'progressive-read-only',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: vi.fn() as typeof globalThis.fetch,
        isOnline: () => false,
        pollIntervalMs: 0,
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
        id: 'progressive-window-refresh',
        endpoint: 'http://app.test/api/listening',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        pageSize: 1,
        pollIntervalMs: 0,
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
        id: 'offline-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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
        id: 'retry-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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
        id: 'failed-attempt-checkpoint',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        fetch: fetch as typeof globalThis.fetch,
        isOnline: () => isOnline,
        pollIntervalMs: 0,
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
        id: 'conflict-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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
        id: 'recover-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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

    rejectWrite = false
    await collection.utils.retryPendingMutation(failed!.id)
    expect(await collection.utils.getPendingMutations()).toHaveLength(0)
    expect(collection.get('recover-1')?.notionPageId).toBe('page-recover-1')
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
        id: 'discard-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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
        id: 'failed-write-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => false,
        fetch: vi.fn() as typeof fetch,
        pollIntervalMs: 0,
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
        id: 'observer-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => false,
        fetch: vi.fn() as typeof fetch,
        pollIntervalMs: 0,
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
        id: 'checkpoint-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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
        id: 'ordered-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => isOnline,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 0,
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

  it('chunks large TanStack transactions into server-safe outbox batches', async () => {
    const storage = createMemoryNotionStorage()
    const collection = createCollection(
      notionCollectionOptions({
        id: 'bulk-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => false,
        fetch: vi.fn() as typeof fetch,
        pollIntervalMs: 0,
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
    expect(persisted?.outbox).toHaveLength(2)
    expect(persisted?.outbox.map((entry) => entry.batch.mutations.length)).toEqual([
      50, 1,
    ])
    expect(new Set(persisted?.outbox.map((entry) => entry.batch.idempotencyKey)).size)
      .toBe(2)
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
        id: 'cleanup-todos',
        endpoint: 'http://app.test/api/todos',
        schema: testSchema,
        storage,
        isOnline: () => true,
        fetch: fetch as typeof globalThis.fetch,
        pollIntervalMs: 10,
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
