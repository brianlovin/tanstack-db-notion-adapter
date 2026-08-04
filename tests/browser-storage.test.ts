import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
  createBrowserNotionStorage,
  type NotionPersistedState,
} from '../src/index.js'

interface StoredTodo {
  id: string
  title: string
}

function persistedState(): NotionPersistedState<StoredTodo> {
  return {
    version: 2,
    revision: 0,
    rows: [{ id: 'todo-1', title: 'Survive a reload' }],
    outbox: [
      {
        id: 'transaction-1',
        createdAt: '2026-08-03T12:00:00.000Z',
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        batch: {
          idempotencyKey: 'transaction-1',
          mutations: [
            {
              type: 'insert',
              key: 'todo-1',
              value: { id: 'todo-1', title: 'Survive a reload' },
            },
          ],
        },
      },
    ],
    lastSyncedAt: null,
  }
}

function createTestStorage() {
  return createBrowserNotionStorage({
    databaseName: `notion-storage-test-${crypto.randomUUID()}`,
  })
}

describe('browser Notion storage', () => {
  it('serializes writers with an IndexedDB lease when Web Locks are unavailable', async () => {
    const databaseName = `notion-lock-test-${crypto.randomUUID()}`
    const firstStorage = createBrowserNotionStorage({ databaseName })
    const secondStorage = createBrowserNotionStorage({ databaseName })
    const events: Array<string> = []
    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = firstStorage.runExclusive!('todos', 'tab-a', async () => {
      events.push('first:start')
      await firstCanFinish
      events.push('first:end')
    })
    await vi.waitFor(() => expect(events).toEqual(['first:start']))

    const second = secondStorage.runExclusive!('todos', 'tab-b', async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
  })

  it('rejects a stale writer with an atomic revision comparison', async () => {
    const databaseName = `notion-cas-test-${crypto.randomUUID()}`
    const firstStorage = createBrowserNotionStorage({ databaseName })
    const secondStorage = createBrowserNotionStorage({ databaseName })
    const initial = persistedState()
    await firstStorage.save('todos', initial)

    const first = { ...initial, revision: 1, rows: [{ id: 'todo-1', title: 'A' }] }
    const stale = { ...initial, revision: 1, rows: [{ id: 'todo-1', title: 'B' }] }

    await expect(firstStorage.compareAndSet!('todos', 0, first)).resolves.toBe(true)
    await expect(secondStorage.compareAndSet!('todos', 0, stale)).resolves.toBe(false)
    expect(await secondStorage.load<StoredTodo>('todos')).toEqual(first)
  })

  it('round-trips cached rows and outbox entries through IndexedDB', async () => {
    const storage = createTestStorage()
    const state = persistedState()

    await storage.save('todos', state)

    expect(storage.kind).toBe('indexeddb')
    expect(await storage.load<StoredTodo>('todos')).toEqual(state)

    await storage.clear('todos')
    expect(await storage.load<StoredTodo>('todos')).toBeNull()
  })

  it('does not treat request success as a committed transaction', async () => {
    const storage = createTestStorage()
    const state = persistedState()
    const originalPut = IDBObjectStore.prototype.put

    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request =
        key === undefined
          ? originalPut.call(this, value)
          : originalPut.call(this, value, key)
      request.addEventListener('success', () => this.transaction.abort())
      return request
    })

    await expect(storage.save('todos', state)).rejects.toThrow(
      'Durable browser storage is unavailable.',
    )

    // The aborted IndexedDB write must be observed. With no localStorage in
    // this test runtime, the adapter refuses a memory-only acknowledgement.
    expect(storage.kind).toBe('unavailable')
    await expect(storage.load<StoredTodo>('todos')).rejects.toThrow(
      'Durable browser storage is unavailable.',
    )
  })
})
