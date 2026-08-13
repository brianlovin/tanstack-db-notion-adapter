import type {
  BaseCollectionConfig,
  CollectionConfig,
  DeleteMutationFnParams,
  InsertMutationFnParams,
  SyncConfig,
  UpdateMutationFnParams,
  UtilsRecord,
} from '@tanstack/db'
import {
  createBrowserSyncLifecycle,
  createJsonRequester,
  NotionSyncError,
} from './browser-sync-runtime.js'
import {
  createNotionStorageId,
  createNotionPersistedStateStore,
  NotionPersistedStateError,
} from './persisted-state.js'
import { createSerializedQueue } from './browser-sync-runtime.js'
import type {
  LegacyNotionPersistedState,
  NotionCollectionStorage,
  NotionOutboxEntry,
  NotionOutboxError,
  NotionPersistedEnvelope,
  NotionPersistedState,
  NotionQuarantineRecord,
  NotionRemotePaginationState,
  NotionStorageLockOptions,
} from './persisted-state.js'
export type {
  LegacyNotionPersistedState,
  NotionCollectionStorage,
  NotionOutboxEntry,
  NotionOutboxError,
  NotionPersistedEnvelope,
  NotionPersistedState,
  NotionQuarantineRecord,
  NotionRemotePaginationState,
  NotionStorageLockOptions,
} from './persisted-state.js'
export { NotionPersistedStateError } from './persisted-state.js'
import type {
  NotionInvalidationVersion,
  NotionListResult,
  NotionMutation,
  NotionMutationBatch,
  NotionMutationResult,
  NotionPropertyConflict,
} from './protocol.js'
import type {
  InferNotionOutput,
  NotionFields,
  NotionSchema,
} from './schema.js'
export { NotionSyncError } from './browser-sync-runtime.js'

export type NotionSyncStatus =
  | 'idle'
  | 'hydrating'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error'

export type NotionSyncProgress =
  | {
      phase: 'push'
      completedMutations: number
      totalMutations: number
      activeBatchMutations: number
    }
  | {
      phase: 'pull'
      loadedPages: number
      loadedRows: number
    }

export interface NotionSyncState {
  status: NotionSyncStatus
  progress: NotionSyncProgress | null
  pendingMutations: number
  lastSyncedAt: number | null
  remoteVersion: number | null
  isOnline: boolean
  storage: NotionCollectionStorage['kind']
  error: string | null
  quarantine: NotionQuarantineRecord | null
  blockedMutation: {
    entryId: string
    error: NotionOutboxError
  } | null
}

export interface NotionCollectionUtils<TItem extends object> extends UtilsRecord {
  /** Enables automatic reconciliation and immediately synchronizes. */
  resumeSync: () => Promise<void>
  /** Stops automatic remote requests without clearing local rows or pending work. */
  pauseSync: () => void
  syncNow: () => Promise<void>
  checkForRemoteChanges: () => Promise<boolean>
  loadMore: () => Promise<void>
  getSyncState: () => NotionSyncState
  getPaginationState: () => NotionRemotePaginationState | null
  subscribeSyncState: (listener: () => void) => () => void
  getPendingMutations: () => Promise<Array<NotionOutboxEntry<TItem>>>
  retryPendingMutation: (entryId: string) => Promise<void>
  discardPendingMutation: (
    entryId: string,
    options: { acceptDataLoss: true },
  ) => Promise<void>
  resolveDeletedMutation: (
    entryId: string,
    options:
      | { action: 'recreate' }
      | { action: 'discard'; acceptDataLoss: true },
  ) => Promise<void>
  getQuarantinedState: () => Promise<NotionQuarantineRecord | null>
  discardQuarantinedState: (options: { acceptDataLoss: true }) => Promise<void>
  resetLocalCache: () => Promise<void>
}

export interface NotionCollectionConfig<TFields extends NotionFields>
  extends Omit<
    BaseCollectionConfig<
      InferNotionOutput<TFields>,
      string,
      NotionSchema<TFields>,
      NotionCollectionUtils<InferNotionOutput<TFields>>
    >,
    | 'schema'
    | 'getKey'
    | 'onInsert'
    | 'onUpdate'
    | 'onDelete'
    | 'syncMode'
    | 'utils'
  > {
  id: string
  /** Immutable account/workspace namespace for browser cache, outbox, and locks. */
  storageScope?: string
  endpoint: string
  schema: NotionSchema<TFields>
  storage?: NotionCollectionStorage
  fetch?: typeof globalThis.fetch
  tuning?: NotionCollectionTuning
  /**
   * Start remote reconciliation as soon as the local cache is ready. Disable
   * this when authentication must finish before the sync endpoint is called.
   * @default true
   */
  autoStart?: boolean
  /** Disable collection mutations for a source that is only read locally. */
  readOnly?: boolean
  /** Fetch every remote page, or materialize one page at a time. @default 'eager' */
  syncMode?: 'eager' | 'progressive'
}

export interface NotionCollectionTuning {
  /** Notion returns at most 100 rows per API page. @default 100 */
  pageSize?: number
  /** Background reconciliation interval. Set to 0 to disable. @default 60000 */
  pollIntervalMs?: number
  /** Poll only the webhook invalidation version. Set to 0 to disable. @default 0 */
  invalidationPollIntervalMs?: number
  /**
   * Maximum time between complete snapshots. Normal polls fetch only rows edited
   * after the remote watermark. Set to 0 to reconcile fully only on syncNow().
   * @default 3600000
   */
  fullReconciliationIntervalMs?: number
  /** Maximum mutations sent in one server request. Must be between 1 and 50. @default 10 */
  maxMutationsPerBatch?: number
  /** Override browser connectivity detection, primarily for non-browser runtimes. */
  isOnline?: () => boolean
  /** Force the IndexedDB lease path for fallback testing. @default 'auto' */
  coordinationStrategy?: 'auto' | 'storage-lease'
  /** Reconcile when a background tab becomes visible. @default true */
  refreshOnWindowFocus?: boolean
}

export interface ClearNotionStorageScopeOptions {
  id: string
  storageScope: string
  storage?: NotionCollectionStorage
  acceptDataLoss: true
}

export class NotionStorageConflictError extends Error {
  readonly code = 'storage_revision_conflict'

  constructor() {
    super('Another browser context committed newer local state. Retrying is safe.')
    this.name = 'NotionStorageConflictError'
  }
}

export class NotionCrossTabCoordinationError extends Error {
  readonly code = 'cross_tab_coordination_unavailable'

  constructor() {
    super(
      'Safe cross-tab coordination is unavailable. Configure storage with runExclusive or use a browser that supports Web Locks.',
    )
    this.name = 'NotionCrossTabCoordinationError'
  }
}

export class NotionStorageUnavailableError extends Error {
  constructor() {
    super(
      'Durable browser storage is unavailable. The adapter will not acknowledge mutations that would be lost on reload.',
    )
    this.name = 'NotionStorageUnavailableError'
  }
}

function clone<T>(value: T): T {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)
}

function rowsEqual(left: object, right: object): boolean {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export function createMemoryNotionStorage(): NotionCollectionStorage {
  const states = new Map<string, NotionPersistedEnvelope<object>>()
  const quarantines = new Map<string, NotionQuarantineRecord>()
  const queues = new Map<string, Promise<void>>()
  return {
    kind: 'memory',
    async load<TItem extends object>(collectionId: string) {
      const value = states.get(collectionId)
      return value ? (clone(value) as NotionPersistedEnvelope<TItem>) : null
    },
    async save<TItem extends object>(
      collectionId: string,
      state: NotionPersistedState<TItem>,
    ) {
      states.set(collectionId, clone(state) as NotionPersistedEnvelope<object>)
    },
    async clear(collectionId: string) {
      states.delete(collectionId)
    },
    async compareAndSet(collectionId, expectedRevision, state) {
      const current = states.get(collectionId)
      const currentRevision = current?.version === 2 ? current.revision : 0
      if (currentRevision !== expectedRevision) return false
      states.set(collectionId, clone(state) as NotionPersistedEnvelope<object>)
      return true
    },
    async quarantine(collectionId, value, reason) {
      const record: NotionQuarantineRecord = {
        collectionId,
        quarantinedAt: new Date().toISOString(),
        reason,
        value: clone(value),
      }
      quarantines.set(collectionId, record)
      states.delete(collectionId)
      return clone(record)
    },
    async loadQuarantine(collectionId) {
      const record = quarantines.get(collectionId)
      return record ? clone(record) : null
    },
    async clearQuarantine(collectionId) {
      quarantines.delete(collectionId)
    },
    async runExclusive(collectionId, _ownerId, operation, options) {
      const previous = queues.get(collectionId) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const queued = previous.then(() => current)
      queues.set(collectionId, queued)
      await previous
      const controller = new AbortController()
      const abort = () => controller.abort(options?.signal?.reason)
      if (options?.signal?.aborted) abort()
      else options?.signal?.addEventListener('abort', abort, { once: true })
      try {
        if (controller.signal.aborted) throw controller.signal.reason
        return await operation(controller.signal)
      } finally {
        options?.signal?.removeEventListener('abort', abort)
        release()
        if (queues.get(collectionId) === queued) queues.delete(collectionId)
      }
    },
  }
}

interface BrowserLeaseRecord {
  ownerId: string
  fence: number
  expiresAt: number
}

class BrowserNotionStorage implements NotionCollectionStorage {
  private readonly databaseName: string
  private readonly storeName: string
  private readonly leaseStoreName: string
  private readonly quarantineStoreName: string
  private readonly localStoragePrefix: string
  private readonly allowMemoryFallback: boolean
  private readonly memory = createMemoryNotionStorage()
  private database: Promise<IDBDatabase> | null = null
  private fallback: 'localstorage' | 'memory' | 'unavailable' | null = null

  constructor(options: {
    databaseName: string
    storeName: string
    allowMemoryFallback: boolean
  }) {
    this.databaseName = options.databaseName
    this.storeName = options.storeName
    this.leaseStoreName = `${options.storeName}:leases`
    this.quarantineStoreName = `${options.storeName}:quarantine`
    this.localStoragePrefix = `${options.databaseName}:`
    this.allowMemoryFallback = options.allowMemoryFallback
  }

  get kind(): NotionCollectionStorage['kind'] {
    return this.fallback ?? 'indexeddb'
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available.'))
        return
      }
      const request = indexedDB.open(this.databaseName, 2)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName)
        }
        if (!request.result.objectStoreNames.contains(this.leaseStoreName)) {
          request.result.createObjectStore(this.leaseStoreName)
        }
        if (!request.result.objectStoreNames.contains(this.quarantineStoreName)) {
          request.result.createObjectStore(this.quarantineStoreName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('IndexedDB open was blocked.'))
    })
    return this.database
  }

  private async idbTransaction<T>(
    storeNames: string | Array<string>,
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const database = await this.open()
    const transaction = database.transaction(storeNames, mode)
    const completion = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('The IndexedDB transaction failed.'))
      }
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('The IndexedDB transaction aborted.'))
      }
    })
    try {
      const result = await operation(transaction)
      await completion
      return result
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // The transaction may already have aborted or completed.
      }
      await completion.catch(() => undefined)
      throw error
    }
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        reject(request.error ?? new Error('The IndexedDB request failed.'))
      }
    })
  }

  private async idbRequest<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return this.idbTransaction(this.storeName, mode, (transaction) =>
      this.request(operation(transaction.objectStore(this.storeName))),
    )
  }

  private canUseLocalStorage(): boolean {
    try {
      if (typeof localStorage === 'undefined') return false
      const key = `${this.localStoragePrefix}probe`
      localStorage.setItem(key, '1')
      localStorage.removeItem(key)
      return true
    } catch {
      return false
    }
  }

  private chooseFallback(): 'localstorage' | 'memory' {
    if (!this.fallback) {
      if (this.canUseLocalStorage()) this.fallback = 'localstorage'
      else if (this.allowMemoryFallback) this.fallback = 'memory'
      else this.fallback = 'unavailable'
    }
    if (this.fallback === 'unavailable') {
      throw new NotionStorageUnavailableError()
    }
    return this.fallback
  }

  private assertAvailable() {
    if (this.fallback === 'unavailable') {
      throw new NotionStorageUnavailableError()
    }
  }

  async load<TItem extends object>(
    collectionId: string,
  ): Promise<NotionPersistedEnvelope<TItem> | null> {
    this.assertAvailable()
    if (!this.fallback) {
      try {
        return (
          (await this.idbRequest('readonly', (store) =>
            store.get(collectionId),
          )) ?? null
        )
      } catch {
        this.chooseFallback()
      }
    }

    if (this.fallback === 'localstorage') {
      const value = localStorage.getItem(`${this.localStoragePrefix}${collectionId}`)
      return value ? (JSON.parse(value) as NotionPersistedEnvelope<TItem>) : null
    }
    return this.memory.load<TItem>(collectionId)
  }

  async save<TItem extends object>(
    collectionId: string,
    state: NotionPersistedState<TItem>,
  ): Promise<void> {
    this.assertAvailable()
    if (!this.fallback) {
      try {
        await this.idbRequest('readwrite', (store) =>
          store.put(clone(state), collectionId),
        )
        return
      } catch {
        this.chooseFallback()
      }
    }

    if (this.fallback === 'localstorage') {
      localStorage.setItem(
        `${this.localStoragePrefix}${collectionId}`,
        JSON.stringify(state),
      )
      return
    }
    await this.memory.save(collectionId, state)
  }

  async clear(collectionId: string): Promise<void> {
    this.assertAvailable()
    if (!this.fallback) {
      try {
        await this.idbRequest('readwrite', (store) => store.delete(collectionId))
        return
      } catch {
        this.chooseFallback()
      }
    }

    if (this.fallback === 'localstorage') {
      localStorage.removeItem(`${this.localStoragePrefix}${collectionId}`)
      return
    }
    await this.memory.clear(collectionId)
  }

  async compareAndSet<TItem extends object>(
    collectionId: string,
    expectedRevision: number,
    state: NotionPersistedState<TItem>,
  ): Promise<boolean> {
    this.assertAvailable()
    if (!this.fallback) {
      try {
        return await this.idbTransaction(
          this.storeName,
          'readwrite',
          async (transaction) => {
            const store = transaction.objectStore(this.storeName)
            const current = (await this.request(store.get(collectionId))) as
              | NotionPersistedEnvelope<TItem>
              | undefined
            const revision = current?.version === 2 ? current.revision : 0
            if (revision !== expectedRevision) return false
            await this.request(store.put(clone(state), collectionId))
            return true
          },
        )
      } catch {
        this.chooseFallback()
      }
    }

    if (this.fallback === 'localstorage') {
      const key = `${this.localStoragePrefix}${collectionId}`
      const serialized = localStorage.getItem(key)
      const current = serialized
        ? (JSON.parse(serialized) as NotionPersistedEnvelope<TItem>)
        : null
      const revision = current?.version === 2 ? current.revision : 0
      if (revision !== expectedRevision) return false
      localStorage.setItem(key, JSON.stringify(state))
      return true
    }
    if (this.fallback === 'memory') {
      return this.memory.compareAndSet!(collectionId, expectedRevision, state)
    }
    throw new NotionStorageUnavailableError()
  }

  async quarantine(
    collectionId: string,
    value: unknown,
    reason: string,
  ): Promise<NotionQuarantineRecord> {
    const record: NotionQuarantineRecord = {
      collectionId,
      quarantinedAt: new Date().toISOString(),
      reason,
      value,
    }
    this.assertAvailable()
    if (!this.fallback) {
      try {
        return await this.idbTransaction(
          [this.storeName, this.quarantineStoreName],
          'readwrite',
          async (transaction) => {
            await this.request(
              transaction
                .objectStore(this.quarantineStoreName)
                .put(clone(record), collectionId),
            )
            await this.request(
              transaction.objectStore(this.storeName).delete(collectionId),
            )
            return record
          },
        )
      } catch {
        this.chooseFallback()
      }
    }

    if (this.fallback === 'localstorage') {
      localStorage.setItem(
        `${this.localStoragePrefix}quarantine:${collectionId}`,
        JSON.stringify(record),
      )
      localStorage.removeItem(`${this.localStoragePrefix}${collectionId}`)
      return clone(record)
    }
    if (this.fallback === 'memory') {
      return this.memory.quarantine!(collectionId, value, reason)
    }
    throw new NotionStorageUnavailableError()
  }

  async loadQuarantine(
    collectionId: string,
  ): Promise<NotionQuarantineRecord | null> {
    this.assertAvailable()
    if (!this.fallback) {
      try {
        return (
          (await this.idbTransaction(
            this.quarantineStoreName,
            'readonly',
            (transaction) =>
              this.request(
                transaction.objectStore(this.quarantineStoreName).get(collectionId),
              ),
          )) ?? null
        )
      } catch {
        this.chooseFallback()
      }
    }
    if (this.fallback === 'localstorage') {
      const value = localStorage.getItem(
        `${this.localStoragePrefix}quarantine:${collectionId}`,
      )
      return value ? (JSON.parse(value) as NotionQuarantineRecord) : null
    }
    if (this.fallback === 'memory') {
      return this.memory.loadQuarantine!(collectionId)
    }
    throw new NotionStorageUnavailableError()
  }

  async clearQuarantine(collectionId: string): Promise<void> {
    this.assertAvailable()
    if (!this.fallback) {
      try {
        await this.idbTransaction(
          this.quarantineStoreName,
          'readwrite',
          (transaction) =>
            this.request(
              transaction
                .objectStore(this.quarantineStoreName)
                .delete(collectionId),
            ),
        )
        return
      } catch {
        this.chooseFallback()
      }
    }
    if (this.fallback === 'localstorage') {
      localStorage.removeItem(
        `${this.localStoragePrefix}quarantine:${collectionId}`,
      )
      return
    }
    if (this.fallback === 'memory') {
      await this.memory.clearQuarantine!(collectionId)
      return
    }
    throw new NotionStorageUnavailableError()
  }

  private async acquireLease(
    collectionId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<BrowserLeaseRecord | null> {
    return this.idbTransaction(
      this.leaseStoreName,
      'readwrite',
      async (transaction) => {
        const store = transaction.objectStore(this.leaseStoreName)
        const current = (await this.request(store.get(collectionId))) as
          | BrowserLeaseRecord
          | undefined
        const now = Date.now()
        if (current && current.ownerId !== ownerId && current.expiresAt > now) {
          return null
        }
        const lease: BrowserLeaseRecord = {
          ownerId,
          fence: (current?.fence ?? 0) + 1,
          expiresAt: now + leaseMs,
        }
        await this.request(store.put(lease, collectionId))
        return lease
      },
    )
  }

  private async renewLease(
    collectionId: string,
    lease: BrowserLeaseRecord,
    leaseMs: number,
  ): Promise<boolean> {
    return this.idbTransaction(
      this.leaseStoreName,
      'readwrite',
      async (transaction) => {
        const store = transaction.objectStore(this.leaseStoreName)
        const current = (await this.request(store.get(collectionId))) as
          | BrowserLeaseRecord
          | undefined
        if (
          current?.ownerId !== lease.ownerId ||
          current.fence !== lease.fence
        ) {
          return false
        }
        await this.request(
          store.put({ ...current, expiresAt: Date.now() + leaseMs }, collectionId),
        )
        return true
      },
    )
  }

  private async releaseLease(
    collectionId: string,
    lease: BrowserLeaseRecord,
  ): Promise<void> {
    await this.idbTransaction(
      this.leaseStoreName,
      'readwrite',
      async (transaction) => {
        const store = transaction.objectStore(this.leaseStoreName)
        const current = (await this.request(store.get(collectionId))) as
          | BrowserLeaseRecord
          | undefined
        if (
          current?.ownerId === lease.ownerId &&
          current.fence === lease.fence
        ) {
          await this.request(store.delete(collectionId))
        }
      },
    )
  }

  async runExclusive<T>(
    collectionId: string,
    ownerId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: NotionStorageLockOptions = {},
  ): Promise<T> {
    const leaseMs = Math.max(5_000, options.leaseMs ?? 30_000)
    const acquireTimeoutMs = Math.max(
      leaseMs,
      options.acquireTimeoutMs ?? 60_000,
    )
    const deadline = Date.now() + acquireTimeoutMs
    let lease: BrowserLeaseRecord | null = null

    try {
      while (!lease) {
        if (options.signal?.aborted) throw options.signal.reason
        lease = await this.acquireLease(collectionId, ownerId, leaseMs)
        if (!lease) {
          if (Date.now() >= deadline) {
            throw new NotionSyncError({
              code: 'cross_tab_lock_timeout',
              message: 'Timed out waiting for another tab to finish syncing.',
            })
          }
          await wait(40 + Math.floor(Math.random() * 40), options.signal)
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof NotionSyncError) throw error
      throw new NotionCrossTabCoordinationError()
    }

    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    const heartbeat = setInterval(() => {
      void this.renewLease(collectionId, lease!, leaseMs)
        .then((renewed) => {
          if (!renewed) controller.abort(new NotionStorageConflictError())
        })
        .catch(() => controller.abort(new NotionStorageConflictError()))
    }, Math.max(1_000, Math.floor(leaseMs / 3)))

    try {
      return await operation(controller.signal)
    } finally {
      clearInterval(heartbeat)
      options.signal?.removeEventListener('abort', abort)
      await this.releaseLease(collectionId, lease).catch(() => undefined)
    }
  }
}

export function createBrowserNotionStorage(
  options: {
    databaseName?: string
    storeName?: string
    /**
     * Allows acknowledged writes to fall back to process memory when durable
     * browser storage is unavailable. Intended for prototypes and tests only.
     * @default false
     */
    allowMemoryFallback?: boolean
  } = {},
): NotionCollectionStorage {
  return new BrowserNotionStorage({
    databaseName: options.databaseName ?? 'tanstack-db-notion',
    storeName: options.storeName ?? 'collections',
    allowMemoryFallback: options.allowMemoryFallback ?? false,
  })
}

/** Clears one scoped row envelope and its matching page-content envelope. */
export async function clearNotionStorageScope(
  options: ClearNotionStorageScopeOptions,
): Promise<void> {
  if (options.acceptDataLoss !== true) {
    throw new NotionSyncError({
      code: 'data_loss_not_accepted',
      message: 'Clearing scoped Notion storage requires acceptDataLoss: true.',
      retryable: false,
    })
  }
  const storage = options.storage ?? createBrowserNotionStorage()
  const collectionId = createNotionStorageId(options.id, options.storageScope)
  for (const storageId of [collectionId, `${collectionId}:page-content`]) {
    await storage.clear(storageId)
    await storage.clearQuarantine?.(storageId)
  }
}

function emptyState<TItem extends object>(): NotionPersistedState<TItem> {
  return { version: 2, revision: 0, rows: [], outbox: [], lastSyncedAt: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidPersistedState(message: string): never {
  throw new NotionPersistedStateError(message)
}

function normalizeOutboxEntry<TItem extends object>(
  value: unknown,
  legacy: boolean,
): NotionOutboxEntry<TItem> {
  if (!isRecord(value) || !isRecord(value.batch)) {
    return invalidPersistedState('A persisted outbox entry is malformed.')
  }
  const batch = value.batch
  if (
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof batch.idempotencyKey !== 'string' ||
    !Array.isArray(batch.mutations)
  ) {
    return invalidPersistedState('A persisted outbox entry is missing required fields.')
  }

  const mutations = batch.mutations.map((mutation) => {
    if (
      !isRecord(mutation) ||
      !['insert', 'update', 'delete'].includes(String(mutation.type)) ||
      typeof mutation.key !== 'string' ||
      !isRecord(mutation.value)
    ) {
      return invalidPersistedState('A persisted mutation is malformed.')
    }
    if (mutation.type === 'update') {
      if (legacy && (!isRecord(mutation.base) || !isRecord(mutation.changes))) {
        return invalidPersistedState(
          'A legacy pending update cannot be migrated without its property-level conflict base.',
        )
      }
      if (!isRecord(mutation.base) || !isRecord(mutation.changes)) {
        return invalidPersistedState(
          'A persisted update is missing its property-level conflict base.',
        )
      }
      return mutation as unknown as NotionMutation<TItem>
    }
    return mutation as unknown as NotionMutation<TItem>
  })

  return {
    id: value.id,
    createdAt: value.createdAt,
    attempts:
      typeof value.attempts === 'number' && value.attempts >= 0
        ? value.attempts
        : 0,
    lastAttemptAt:
      typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    lastError:
      isRecord(value.lastError) &&
      typeof value.lastError.code === 'string' &&
      typeof value.lastError.message === 'string'
        ? {
            code: value.lastError.code,
            message: value.lastError.message,
            status:
              typeof value.lastError.status === 'number'
                ? value.lastError.status
                : null,
            retryable: value.lastError.retryable !== false,
            occurredAt:
              typeof value.lastError.occurredAt === 'string'
                ? value.lastError.occurredAt
                : new Date(0).toISOString(),
            conflicts: Array.isArray(value.lastError.conflicts)
              ? (value.lastError.conflicts as Array<NotionPropertyConflict>)
              : [],
          }
        : null,
    batch: {
      idempotencyKey: batch.idempotencyKey,
      mutations,
    },
  }
}

function migratePersistedState<TItem extends object>(
  value: NotionPersistedEnvelope<TItem> | null,
): { state: NotionPersistedState<TItem>; migrated: boolean } {
  if (value === null) return { state: emptyState<TItem>(), migrated: false }
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return invalidPersistedState(
      'The persisted collection uses an unknown or invalid storage format.',
    )
  }
  if (
    !Array.isArray(value.rows) ||
    !Array.isArray(value.outbox) ||
    (value.lastSyncedAt !== null && typeof value.lastSyncedAt !== 'number')
  ) {
    return invalidPersistedState('The persisted collection envelope is malformed.')
  }
  if (
    value.version === 2 &&
    (!Number.isInteger(value.revision) || value.revision < 0)
  ) {
    return invalidPersistedState('The persisted collection revision is invalid.')
  }
  if (
    value.version === 2 &&
    value.remoteVersion !== undefined &&
    (!Number.isInteger(value.remoteVersion) || value.remoteVersion < 0)
  ) {
    return invalidPersistedState('The persisted remote version is invalid.')
  }
  if (
    value.version === 2 &&
    value.remoteWatermark !== undefined &&
    (typeof value.remoteWatermark !== 'string' ||
      !Number.isFinite(Date.parse(value.remoteWatermark)))
  ) {
    return invalidPersistedState('The persisted remote watermark is invalid.')
  }
  if (
    value.version === 2 &&
    value.lastFullReconciledAt !== undefined &&
    (!Number.isFinite(value.lastFullReconciledAt) ||
      value.lastFullReconciledAt < 0)
  ) {
    return invalidPersistedState(
      'The persisted full reconciliation time is invalid.',
    )
  }
  if (
    value.version === 2 &&
    value.pagination !== undefined &&
    (!isRecord(value.pagination) ||
      value.pagination.mode !== 'progressive' ||
      !Number.isInteger(value.pagination.loadedPages) ||
      value.pagination.loadedPages < 0 ||
      (value.pagination.nextCursor !== null &&
        typeof value.pagination.nextCursor !== 'string') ||
      typeof value.pagination.hasMore !== 'boolean' ||
      (value.pagination.hasMore && !value.pagination.nextCursor))
  ) {
    return invalidPersistedState('The persisted pagination checkpoint is invalid.')
  }

  return {
    state: {
      version: 2,
      revision: value.version === 2 ? value.revision : 0,
      rows: value.rows as Array<TItem>,
      outbox: value.outbox.map((entry) =>
        normalizeOutboxEntry<TItem>(entry, value.version === 1),
      ),
      lastSyncedAt: value.lastSyncedAt,
      remoteWatermark:
        value.version === 2 && value.remoteWatermark !== undefined
          ? value.remoteWatermark
          : undefined,
      lastFullReconciledAt:
        value.version === 2 && value.lastFullReconciledAt !== undefined
          ? value.lastFullReconciledAt
          : value.lastSyncedAt ?? undefined,
      remoteVersion:
        value.version === 2 && value.remoteVersion !== undefined
          ? value.remoteVersion
          : undefined,
      pagination:
        value.version === 2 && value.pagination !== undefined
          ? (value.pagination as unknown as NotionRemotePaginationState)
          : undefined,
    },
    migrated: value.version === 1,
  }
}

function randomInstanceId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

/**
 * Creates TanStack DB collection options backed by a Notion data source.
 * Rows are hydrated from browser storage before network reconciliation, and
 * direct collection mutations are durably queued before TanStack marks them as
 * persisted.
 */
export function notionCollectionOptions<const TFields extends NotionFields>(
  config: NotionCollectionConfig<TFields>,
): CollectionConfig<
  InferNotionOutput<TFields>,
  string,
  NotionSchema<TFields>,
  NotionCollectionUtils<InferNotionOutput<TFields>>
> & {
  schema: NotionSchema<TFields>
  utils: NotionCollectionUtils<InferNotionOutput<TFields>>
} {
  type TItem = InferNotionOutput<TFields>
  type SyncParams = Parameters<SyncConfig<TItem, string>['sync']>[0]

  const storage = config.storage ?? createBrowserNotionStorage()
  const storageId = createNotionStorageId(config.id, config.storageScope)
  const persistence = createNotionPersistedStateStore<TItem>(
    storage,
    storageId,
  )
  const fetcher = config.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetcher) throw new Error('A fetch implementation is required.')
  if (config.syncMode === 'progressive' && !config.readOnly) {
    throw new Error('Progressive sync requires a read-only collection.')
  }

  const endpoint = config.endpoint.replace(/\/$/, '')
  const tuning = config.tuning ?? {}
  const pageSize = Math.min(100, Math.max(1, tuning.pageSize ?? 100))
  const pollIntervalMs = Math.max(0, tuning.pollIntervalMs ?? 60_000)
  const invalidationPollIntervalMs = Math.max(
    0,
    tuning.invalidationPollIntervalMs ?? 0,
  )
  const fullReconciliationIntervalMs = Math.max(
    0,
    tuning.fullReconciliationIntervalMs ?? 60 * 60_000,
  )
  const maxMutationsPerBatch = Math.min(
    50,
    Math.max(1, Math.floor(tuning.maxMutationsPerBatch ?? 10)),
  )
  const instanceId = randomInstanceId()
  const listeners = new Set<() => void>()

  let state = emptyState<TItem>()
  let rows = new Map<string, TItem>()
  let sink: SyncParams | null = null
  let disposed = false
  let syncEnabled = config.autoStart !== false
  let initialized = false
  let initializeResolve!: () => void
  let channel: BroadcastChannel | null = null
  let quarantine: NotionQuarantineRecord | null = null
  const operationQueue = createSerializedQueue()
  const lifecycle = createBrowserSyncLifecycle({
    ...(tuning.isOnline ? { isOnline: tuning.isOnline } : {}),
    ...(tuning.refreshOnWindowFocus === undefined
      ? {}
      : { refreshOnWindowFocus: tuning.refreshOnWindowFocus }),
    focusMode: 'visible-document',
    pollIntervalMs,
    invalidationPollIntervalMs,
    onOnline: () => handleOnline(),
    onOffline: () => handleOffline(),
    onFocus: () => handleOnline(),
    onInvalidationPoll: () => handleInvalidationPoll(),
  })
  const online = lifecycle.online
  const requestJson = createJsonRequester({ fetch: fetcher })
  const initialization = new Promise<void>((resolve) => {
    initializeResolve = resolve
  })
  let syncState: NotionSyncState = {
    status: 'idle',
    progress: null,
    pendingMutations: 0,
    lastSyncedAt: null,
    remoteVersion: null,
    isOnline: online(),
    storage: storage.kind,
    error: null,
    quarantine: null,
    blockedMutation: null,
  }

  const setSyncState = (patch: Partial<NotionSyncState>) => {
    const progress =
      'progress' in patch
        ? (patch.progress ?? null)
        : 'status' in patch
          ? null
          : syncState.progress
    syncState = {
      ...syncState,
      ...patch,
      progress,
      pendingMutations: state.outbox.length,
      lastSyncedAt: state.lastSyncedAt,
      remoteVersion: state.remoteVersion ?? null,
      isOnline: online(),
      storage: storage.kind,
      quarantine,
      blockedMutation:
        state.outbox[0]?.lastError?.retryable === false
          ? {
              entryId: state.outbox[0].id,
              error: {
                ...state.outbox[0].lastError,
                conflicts: [...state.outbox[0].lastError.conflicts],
              },
            }
          : null,
    }
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Observer failures must never change a persistence outcome.
      }
    }
  }

  const exclusive = operationQueue.run

  const crossTab = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (
          tuning.coordinationStrategy !== 'storage-lease' &&
          typeof navigator !== 'undefined' &&
          navigator.locks
        ) {
          return await navigator.locks.request(
            `tanstack-db-notion:${storageId}`,
            { signal: lifecycle.signal },
            () => operation(lifecycle.signal),
          )
        }
        if (storage.runExclusive) {
          return await storage.runExclusive(storageId, instanceId, operation, {
            signal: lifecycle.signal,
          })
        }
        if (typeof window !== 'undefined') {
          throw new NotionCrossTabCoordinationError()
        }
        return await operation(lifecycle.signal)
      } catch (error) {
        if (!(error instanceof NotionStorageConflictError) || attempt >= 4) {
          throw error
        }
      }
    }
  }

  const applyToMap = (
    map: Map<string, TItem>,
    mutations: ReadonlyArray<NotionMutation<TItem>>,
  ) => {
    for (const mutation of mutations) {
      if (mutation.type === 'delete') map.delete(mutation.key)
      else map.set(mutation.key, mutation.value)
    }
  }

  const applyRows = (nextRows: Map<string, TItem>) => {
    if (!sink || disposed) {
      rows = nextRows
      return
    }

    const changes: Array<
      | { type: 'insert'; key: string; value: TItem }
      | { type: 'update'; key: string; value: TItem }
      | { type: 'delete'; key: string; value: TItem }
    > = []
    for (const [key, value] of rows) {
      if (!nextRows.has(key)) changes.push({ type: 'delete', key, value })
    }
    for (const [key, value] of nextRows) {
      const current = rows.get(key)
      if (current === undefined) changes.push({ type: 'insert', key, value })
      else if (!rowsEqual(current, value)) {
        changes.push({ type: 'update', key, value })
      }
    }

    if (changes.length > 0) {
      sink.begin({ immediate: true })
      for (const change of changes) {
        if (change.type === 'delete') sink.write({ type: 'delete', key: change.key })
        else sink.write({ type: change.type, value: change.value })
      }
      sink.commit()
    }
    rows = nextRows
  }

  const hydratePersistedState = async (
    persisted: NotionPersistedEnvelope<TItem> | null,
  ) => {
    const migrated = migratePersistedState(persisted)
    state = migrated.state
    const validRows = new Map<string, TItem>()
    for (const row of state.rows) {
      const result = await config.schema['~standard'].validate(row)
      if ('issues' in result) {
        throw new NotionPersistedStateError(
          'A cached row no longer matches the configured schema.',
        )
      }
      validRows.set(config.schema.getKey(result.value), result.value)
    }
    for (const entry of state.outbox) {
      for (const mutation of entry.batch.mutations) {
        const result = await config.schema['~standard'].validate(mutation.value)
        if ('issues' in result) {
          throw new NotionPersistedStateError(
            'A pending mutation no longer matches the configured schema.',
          )
        }
      }
    }
    state.rows = [...validRows.values()]
    if (migrated.migrated) {
      const nextState = { ...state, revision: state.revision + 1 }
      const saved = await persistence.compareAndSet(nextState)
      if (!saved) throw new NotionStorageConflictError()
      state = nextState
    }
    applyRows(validRows)
  }

  const reload = async () => {
    const persisted = await persistence.reload()
    try {
      await hydratePersistedState(persisted)
    } catch (error) {
      if (
        error instanceof NotionPersistedStateError &&
        persisted !== null &&
        storage.quarantine
      ) {
        quarantine = await storage.quarantine(
          storageId,
          persisted,
          error.message,
        )
      }
      throw error
    }
  }

  const broadcast = () => {
    try {
      channel?.postMessage({ source: instanceId })
    } catch {
      // A closed or unavailable channel does not change durable state.
    }
  }

  const commitState = async (
    nextState: NotionPersistedState<TItem>,
    nextRows?: Map<string, TItem>,
  ) => {
    if (disposed) throw lifecycle.signal.reason
    const committed = { ...nextState, version: 2 as const, revision: state.revision + 1 }
    const saved = await persistence.compareAndSet(committed)
    if (!saved) throw new NotionStorageConflictError()
    state = committed
    if (nextRows) applyRows(nextRows)
    broadcast()
    setSyncState({})
  }

  const persistStateOnly = (nextState: NotionPersistedState<TItem>) =>
    commitState(nextState)

  const outboxError = (error: unknown): NotionOutboxError => ({
    code: error instanceof NotionSyncError ? error.code : 'sync_error',
    message: error instanceof Error ? error.message : 'Sync failed.',
    status: error instanceof NotionSyncError ? error.status : null,
    retryable: error instanceof NotionSyncError ? error.retryable : true,
    occurredAt: new Date().toISOString(),
    conflicts:
      error instanceof NotionSyncError ? [...error.conflicts] : [],
  })

  const fetchPage = async (
    cursor: string | null,
    signal: AbortSignal,
    editedAfter?: string,
  ) => {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://localhost')
    url.searchParams.set('pageSize', String(pageSize))
    if (cursor) url.searchParams.set('cursor', cursor)
    if (editedAfter) url.searchParams.set('editedAfter', editedAfter)
    const result = await requestJson<NotionListResult<TItem>>(url.toString(), {
      signal,
    })
    if (result.hasMore && !result.nextCursor) {
      throw new NotionSyncError({
        code: 'missing_cursor',
        message: 'The sync server reported another page without a cursor.',
        retryable: false,
      })
    }
    if (cursor && result.nextCursor === cursor) {
      throw new NotionSyncError({
        code: 'repeated_cursor',
        message: 'The sync server returned the same pagination cursor twice.',
        retryable: false,
      })
    }
    return result
  }

  const flush = async (signal: AbortSignal): Promise<boolean> => {
    let requiresRefresh = false
    const totalMutations = state.outbox.reduce(
      (total, entry) => total + entry.batch.mutations.length,
      0,
    )
    let completedMutations = 0
    if (totalMutations > 0) {
      setSyncState({
        progress: {
          phase: 'push',
          completedMutations,
          totalMutations,
          activeBatchMutations: state.outbox[0]!.batch.mutations.length,
        },
      })
    }
    while (state.outbox.length > 0) {
      const entry = state.outbox[0]!
      let result: NotionMutationResult<TItem>
      try {
        result = await requestJson<NotionMutationResult<TItem>>(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry.batch),
          signal,
        })
      } catch (error) {
        if (signal.reason instanceof NotionStorageConflictError) {
          throw signal.reason
        }
        if (error instanceof NotionStorageConflictError) throw error
        const failedEntry: NotionOutboxEntry<TItem> = {
          ...entry,
          attempts: entry.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: outboxError(error),
        }
        await persistStateOnly({
          ...state,
          outbox: [failedEntry, ...state.outbox.slice(1)],
        })
        throw error
      }

      const next = new Map(rows)
      for (const key of result.deletedKeys) next.delete(key)
      for (const row of result.rows) next.set(config.schema.getKey(row), row)
      let remoteVersion = state.remoteVersion
      if (result.invalidation) {
        const { versionBefore, versionAfter } = result.invalidation
        const isOwnContiguousChange =
          remoteVersion === versionBefore &&
          (versionAfter === versionBefore || versionAfter === versionBefore + 1)
        if (remoteVersion === versionAfter || isOwnContiguousChange) {
          remoteVersion = versionAfter
        } else {
          requiresRefresh = true
        }
      }
      const remainingOutbox = state.outbox.slice(1)
      for (const pending of remainingOutbox) {
        applyToMap(next, pending.batch.mutations)
      }
      await commitState(
        {
          ...state,
          rows: [...next.values()],
          outbox: remainingOutbox,
          remoteVersion,
        },
        next,
      )
      completedMutations += entry.batch.mutations.length
      setSyncState({
        progress: {
          phase: 'push',
          completedMutations,
          totalMutations,
          activeBatchMutations: state.outbox[0]?.batch.mutations.length ?? 0,
        },
      })
    }
    return requiresRefresh
  }

  const refresh = async (
    signal: AbortSignal,
    requestedMode: 'full' | 'auto' = 'full',
  ) => {
    const now = Date.now()
    const fullReconciliationDue =
      fullReconciliationIntervalMs > 0 &&
      (state.lastFullReconciledAt === undefined ||
        now - state.lastFullReconciledAt >= fullReconciliationIntervalMs)
    const mode =
      requestedMode === 'full' ||
      config.syncMode === 'progressive' ||
      state.lastSyncedAt === null ||
      !state.remoteWatermark ||
      fullReconciliationDue
        ? 'full'
        : 'incremental'
    const publishBootstrapPages =
      mode === 'full' &&
      config.syncMode !== 'progressive' &&
      state.lastSyncedAt === null
    const editedAfter = mode === 'incremental' ? state.remoteWatermark : undefined
    const remote = mode === 'full' ? new Map<string, TItem>() : new Map(rows)
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    let loadedPages = 0
    let loadedRows = 0
    let remoteVersion: number | undefined
    let remoteWatermark = mode === 'full' ? undefined : state.remoteWatermark
    const targetPages =
      config.syncMode === 'progressive'
        ? Math.max(1, state.pagination?.loadedPages ?? 1)
        : Number.POSITIVE_INFINITY

    setSyncState({
      progress: { phase: 'pull', loadedPages: 0, loadedRows: 0 },
    })

    do {
      const result = await fetchPage(cursor, signal, editedAfter)
      if (result.version !== undefined) {
        if (
          remoteVersion !== undefined &&
          remoteVersion !== result.version
        ) {
          throw new NotionSyncError({
            code: 'remote_version_changed',
            message: 'The remote collection changed during pagination.',
            retryable: true,
          })
        }
        remoteVersion = result.version
      }
      if (
        result.watermark &&
        (!remoteWatermark || result.watermark > remoteWatermark)
      ) {
        remoteWatermark = result.watermark
      }
      for (const row of result.rows) remote.set(config.schema.getKey(row), row)
      loadedPages += 1
      loadedRows += result.rows.length
      setSyncState({
        progress: { phase: 'pull', loadedPages, loadedRows },
      })
      cursor = result.hasMore ? result.nextCursor : null
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new NotionSyncError({
            code: 'repeated_cursor',
            message: 'The sync server returned the same pagination cursor twice.',
            retryable: false,
          })
        }
        seenCursors.add(cursor)
      }
      if (publishBootstrapPages && cursor) {
        const partial = new Map(rows)
        for (const row of remote.values()) {
          partial.set(config.schema.getKey(row), row)
        }
        for (const entry of state.outbox) {
          applyToMap(partial, entry.batch.mutations)
        }
        await commitState(
          {
            ...state,
            rows: [...partial.values()],
            remoteWatermark,
          },
          partial,
        )
      }
    } while (cursor && loadedPages < targetPages)

    for (const entry of state.outbox) applyToMap(remote, entry.batch.mutations)
    await commitState(
      {
        ...state,
        rows: [...remote.values()],
        lastSyncedAt: now,
        remoteWatermark,
        lastFullReconciledAt:
          mode === 'full' && config.syncMode !== 'progressive'
            ? now
            : state.lastFullReconciledAt,
        remoteVersion: remoteVersion ?? state.remoteVersion,
        pagination:
          config.syncMode === 'progressive'
            ? {
                mode: 'progressive',
                loadedPages,
                nextCursor: cursor,
                hasMore: cursor !== null,
              }
            : undefined,
      },
      remote,
    )
  }

  const synchronize = (
    mode: 'auto' | 'full' | 'flush' = 'auto',
  ): Promise<void> =>
    exclusive(async () => {
      await initialization
      if (disposed) return
      if (!online()) {
        setSyncState({ status: 'offline', error: null })
        return
      }

      setSyncState({ status: 'syncing', error: null })
      try {
        await crossTab(async (signal) => {
          await reload()
          const requiresRefresh = await flush(signal)
          if (mode !== 'flush' || requiresRefresh) {
            await refresh(signal, mode === 'full' ? 'full' : 'auto')
          }
        })
        setSyncState({ status: 'synced', error: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Sync failed.'
        setSyncState({
          status: online() ? 'error' : 'offline',
          error: message,
        })
        throw error
      }
    })

  const checkForRemoteChanges = async (): Promise<boolean> => {
    await initialization
    if (disposed) throw lifecycle.signal.reason
    if (!online()) {
      setSyncState({ status: 'offline', error: null })
      return false
    }
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://localhost')
    url.searchParams.set('action', 'version')
    const result = await requestJson<NotionInvalidationVersion>(url.toString(), {
      signal: lifecycle.signal,
    })
    if (state.remoteVersion === result.version) return false
    await synchronize('auto')
    return true
  }

  const loadMore = async (): Promise<void> => {
    await initialization
    if (config.syncMode !== 'progressive') return
    if (!online()) {
      setSyncState({ status: 'offline', error: null })
      return
    }

    await exclusive(async () => {
      setSyncState({ status: 'syncing', error: null })
      try {
        await crossTab(async (signal) => {
          await reload()
          let pagination = state.pagination
          if (pagination && !pagination.hasMore) return

          const cursor = pagination?.nextCursor ?? null
          let result = await fetchPage(cursor, signal)
          setSyncState({
            progress: {
              phase: 'pull',
              loadedPages: 1,
              loadedRows: result.rows.length,
            },
          })
          if (
            state.remoteVersion !== undefined &&
            result.version !== undefined &&
            state.remoteVersion !== result.version
          ) {
            await refresh(signal)
            pagination = state.pagination
            if (pagination && !pagination.hasMore) return
            result = await fetchPage(
              pagination?.nextCursor ?? null,
              signal,
            )
          }
          const next = new Map(rows)
          for (const row of result.rows) next.set(config.schema.getKey(row), row)
          const nextCursor = result.hasMore ? result.nextCursor : null
          await commitState(
            {
              ...state,
              rows: [...next.values()],
              lastSyncedAt: Date.now(),
              remoteWatermark:
                result.watermark &&
                (!state.remoteWatermark || result.watermark > state.remoteWatermark)
                  ? result.watermark
                  : state.remoteWatermark,
              remoteVersion: result.version ?? state.remoteVersion,
              pagination: {
                mode: 'progressive',
                loadedPages: (pagination?.loadedPages ?? 0) + 1,
                nextCursor,
                hasMore: nextCursor !== null,
              },
            },
            next,
          )
        })
        setSyncState({ status: 'synced', error: null })
      } catch (error) {
        setSyncState({
          status: online() ? 'error' : 'offline',
          error: error instanceof Error ? error.message : 'Sync failed.',
        })
        throw error
      }
    })
  }

  const queueMutations = async (
    transactionId: string,
    mutations: Array<NotionMutation<TItem>>,
  ) => {
    await initialization
    await exclusive(() =>
      crossTab(async () => {
        await reload()
        const durableMutations = clone(mutations)
        const createdAt = new Date().toISOString()
        const entries: Array<NotionOutboxEntry<TItem>> = []
        const chunkCount = Math.ceil(
          durableMutations.length / maxMutationsPerBatch,
        )
        for (let index = 0; index < chunkCount; index += 1) {
          const id =
            chunkCount === 1
              ? transactionId
              : `${transactionId}:${index + 1}-of-${chunkCount}`
          entries.push({
            id,
            createdAt,
            attempts: 0,
            lastAttemptAt: null,
            lastError: null,
            batch: {
              idempotencyKey: id,
              mutations: durableMutations.slice(
                index * maxMutationsPerBatch,
                (index + 1) * maxMutationsPerBatch,
              ),
            },
          })
        }
        const next = new Map(rows)
        applyToMap(next, durableMutations)

        const nextState: NotionPersistedState<TItem> = {
          ...state,
          rows: [...next.values()],
          outbox: [...state.outbox, ...entries],
        }
        await commitState(nextState, next)
        let status: NotionSyncStatus = 'offline'
        if (online()) status = syncEnabled ? 'syncing' : 'idle'
        setSyncState({
          status,
          error: null,
        })
      }),
    )

    if (syncEnabled && online()) void synchronize('flush').catch(() => undefined)
  }

  const onInsert = async (params: InsertMutationFnParams<TItem, string>) => {
    await queueMutations(
      params.transaction.id,
      params.transaction.mutations.map((mutation) => ({
        type: 'insert',
        key: String(mutation.key),
        value: mutation.modified,
      })),
    )
  }

  const onUpdate = async (params: UpdateMutationFnParams<TItem, string>) => {
    await queueMutations(
      params.transaction.id,
      params.transaction.mutations.map((mutation) => ({
        type: 'update',
        key: String(mutation.key),
        value: mutation.modified,
        base: Object.fromEntries(
          Object.keys(mutation.changes).map((key) => [
            key,
            mutation.original[key as keyof TItem],
          ]),
        ) as Partial<TItem>,
        changes: mutation.changes,
      })),
    )
  }

  const onDelete = async (params: DeleteMutationFnParams<TItem, string>) => {
    await queueMutations(
      params.transaction.id,
      params.transaction.mutations.map((mutation) => ({
        type: 'delete',
        key: String(mutation.key),
        value: mutation.original,
      })),
    )
  }

  const handleOnline = () => {
    if (syncEnabled) void synchronize('auto').catch(() => undefined)
  }
  const handleInvalidationPoll = () => {
    if (!syncEnabled) return
    void checkForRemoteChanges().catch((error) => {
      setSyncState({
        status: online() ? 'error' : 'offline',
        error: error instanceof Error ? error.message : 'Change detection failed.',
      })
    })
  }
  const handleOffline = () => setSyncState({ status: 'offline', error: null })
  const sync: SyncConfig<TItem, string> = {
    rowUpdateMode: 'full',
    sync(params) {
      sink = params
      setSyncState({ status: 'hydrating', error: null })

      lifecycle.start()
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(`tanstack-db-notion:${storageId}`)
        channel.addEventListener('message', (event) => {
          if ((event.data as { source?: string } | null)?.source === instanceId) return
          void exclusive(() =>
            crossTab(async () => {
              await reload()
              setSyncState({})
            }),
          )
        })
      }

      void (async () => {
        try {
          await crossTab(async () => reload())
          setSyncState({
            status: online() ? 'idle' : 'offline',
            error: null,
          })
        } catch (error) {
          setSyncState({
            status: 'error',
            error:
              error instanceof Error
                ? `Could not hydrate the local cache: ${error.message}`
                : 'Could not hydrate the local cache.',
          })
        } finally {
          initialized = true
          initializeResolve()
          params.markReady()
        }
        if (syncEnabled && online()) {
          void synchronize('auto').catch(() => undefined)
        }
      })()

      return () => {
        disposed = true
        lifecycle.dispose(new Error('The Notion collection was disposed.'))
        sink = null
        if (!initialized) initializeResolve()
        channel?.close()
        channel = null
        listeners.clear()
      }
    },
  }

  const utils: NotionCollectionUtils<TItem> = {
    async resumeSync() {
      syncEnabled = true
      await synchronize('full')
    },
    pauseSync() {
      syncEnabled = false
      setSyncState({
        status: online() ? 'idle' : 'offline',
        error: null,
      })
    },
    syncNow: () => synchronize('full'),
    checkForRemoteChanges,
    loadMore,
    getSyncState: () => syncState,
    getPaginationState: () =>
      state.pagination ? clone(state.pagination) : null,
    subscribeSyncState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async getPendingMutations() {
      await initialization
      return clone(state.outbox)
    },
    async retryPendingMutation(entryId) {
      await initialization
      await exclusive(() =>
        crossTab(async () => {
          await reload()
          const index = state.outbox.findIndex((entry) => entry.id === entryId)
          if (index < 0) {
            throw new NotionSyncError({
              code: 'outbox_entry_not_found',
              message: 'The pending mutation no longer exists.',
              retryable: false,
            })
          }
          const outbox = [...state.outbox]
          outbox[index] = {
            ...outbox[index]!,
            lastError: null,
          }
          await persistStateOnly({ ...state, outbox })
        }),
      )
      if (online()) await synchronize('full')
      else setSyncState({ status: 'offline', error: null })
    },
    async discardPendingMutation(entryId, options) {
      await initialization
      if (options.acceptDataLoss !== true) {
        throw new NotionSyncError({
          code: 'data_loss_not_accepted',
          message: 'Discarding a pending mutation requires acceptDataLoss: true.',
          retryable: false,
        })
      }
      if (!online()) {
        throw new NotionSyncError({
          code: 'discard_requires_online',
          message: 'Reconnect before discarding so the local snapshot can refresh.',
          retryable: true,
        })
      }
      await exclusive(() =>
        crossTab(async () => {
          await reload()
          const outbox = state.outbox.filter((entry) => entry.id !== entryId)
          if (outbox.length === state.outbox.length) {
            throw new NotionSyncError({
              code: 'outbox_entry_not_found',
              message: 'The pending mutation no longer exists.',
              retryable: false,
            })
          }
          await persistStateOnly({ ...state, outbox })
        }),
      )
      await synchronize('full')
    },
    async resolveDeletedMutation(entryId, options) {
      await initialization
      if (options.action === 'discard' && options.acceptDataLoss !== true) {
        throw new NotionSyncError({
          code: 'data_loss_not_accepted',
          message:
            'Discarding a remotely deleted row requires acceptDataLoss: true.',
          retryable: false,
        })
      }
      if (!online()) {
        throw new NotionSyncError({
          code: 'discard_requires_online',
          message: 'Reconnect before resolving a remotely deleted row.',
          retryable: true,
        })
      }
      await exclusive(() =>
        crossTab(async () => {
          await reload()
          const index = state.outbox.findIndex((entry) => entry.id === entryId)
          if (index < 0) {
            throw new NotionSyncError({
              code: 'outbox_entry_not_found',
              message: 'The pending mutation no longer exists.',
              retryable: false,
            })
          }
          if (index !== 0) {
            throw new NotionSyncError({
              code: 'deleted_mutation_not_resolvable',
              message: 'Only the blocked head mutation can be resolved.',
              retryable: false,
            })
          }
          const entry = state.outbox[index]!
          if (entry.lastError?.code !== 'page_not_found') {
            throw new NotionSyncError({
              code: 'deleted_mutation_not_resolvable',
              message:
                'Only a pending mutation blocked by page_not_found can be resolved this way.',
              retryable: false,
            })
          }
          const mutation = entry.batch.mutations[0]
          if (entry.batch.mutations.length !== 1) {
            throw new NotionSyncError({
              code: 'deleted_mutation_not_resolvable',
              message:
                'Only a single pending row mutation can be resolved after deletion.',
              retryable: false,
            })
          }
          const outbox = [...state.outbox]
          if (options.action === 'recreate') {
            const update = mutation
            if (!update || update.type !== 'update') {
              throw new NotionSyncError({
                code: 'deleted_mutation_not_resolvable',
                message:
                  'Only a single pending row update can be recreated after deletion.',
                retryable: false,
              })
            }
            outbox[index] = {
              ...entry,
              attempts: 0,
              lastAttemptAt: null,
              lastError: null,
              batch: {
                ...entry.batch,
                idempotencyKey: randomInstanceId(),
                mutations: [
                  {
                    type: 'insert',
                    key: update.key,
                    value: update.value,
                    idempotencyKey: randomInstanceId(),
                  },
                ],
              },
            }
            await persistStateOnly({ ...state, outbox })
            return
          }
          const key = mutation?.key
          const rows =
            key === undefined
              ? state.rows
              : state.rows.filter((row) => config.schema.getKey(row) !== key)
          outbox.splice(index, 1)
          await commitState({ ...state, rows, outbox }, new Map(
            rows.map((row) => [config.schema.getKey(row), row]),
          ))
        }),
      )
      await synchronize('full')
    },
    async getQuarantinedState() {
      await initialization
      quarantine = (await persistence.loadQuarantine()) ?? quarantine
      return quarantine ? clone(quarantine) : null
    },
    async discardQuarantinedState(options) {
      await initialization
      if (options.acceptDataLoss !== true) {
        throw new NotionSyncError({
          code: 'data_loss_not_accepted',
          message: 'Discarding quarantined state requires acceptDataLoss: true.',
          retryable: false,
        })
      }
      if (!storage.clearQuarantine) {
        throw new NotionSyncError({
          code: 'quarantine_recovery_unavailable',
          message: 'The configured storage cannot clear quarantined state.',
          retryable: false,
        })
      }
      await crossTab(async () => {
        await persistence.clearQuarantine()
        quarantine = null
        state = emptyState<TItem>()
        await persistence.saveReset({
          ...state,
          revision: state.revision + 1,
        })
        applyRows(new Map())
        setSyncState({
          status: online() ? 'idle' : 'offline',
          error: null,
        })
      })
      if (online()) await synchronize('full')
    },
    async resetLocalCache() {
      await initialization
      await exclusive(() =>
        crossTab(async () => {
          await storage.clear(storageId)
          state = emptyState<TItem>()
          applyRows(new Map())
          broadcast()
          setSyncState({
            status: online() ? 'idle' : 'offline',
            error: null,
          })
        }),
      )
      if (online()) await synchronize('full')
    },
  }

  const {
    endpoint: _endpoint,
    fetch: _fetch,
    storage: _storage,
    storageScope: _storageScope,
    tuning: _tuning,
    syncMode: _syncMode,
    ...baseConfig
  } = config

  return {
    ...baseConfig,
    schema: config.schema,
    getKey: config.schema.getKey,
    startSync: config.startSync ?? true,
    sync,
    ...(config.readOnly ? {} : { onInsert, onUpdate, onDelete }),
    utils,
  }
}
