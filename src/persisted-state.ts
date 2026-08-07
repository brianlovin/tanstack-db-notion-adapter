import { createSerializedQueue } from './browser-sync-runtime.js'
import type {
  NotionMutationBatch,
  NotionPropertyConflict,
} from './protocol.js'

export { createSerializedQueue }

export class NotionPersistedStateError extends Error {
  readonly code = 'persisted_state_quarantined'

  constructor(message: string) {
    super(message)
    this.name = 'NotionPersistedStateError'
  }
}

export interface NotionOutboxError {
  code: string
  message: string
  status: number | null
  retryable: boolean
  occurredAt: string
  conflicts: Array<NotionPropertyConflict>
}

export interface NotionOutboxEntry<TItem extends object> {
  id: string
  createdAt: string
  attempts: number
  lastAttemptAt: string | null
  lastError: NotionOutboxError | null
  batch: NotionMutationBatch<TItem>
}

export interface LegacyNotionPersistedState<TItem extends object> {
  version: 1
  rows: Array<TItem>
  outbox: Array<NotionOutboxEntry<TItem>>
  lastSyncedAt: number | null
}

export interface NotionRemotePaginationState {
  mode: 'progressive'
  loadedPages: number
  nextCursor: string | null
  hasMore: boolean
}

export interface NotionPersistedState<TItem extends object> {
  version: 2
  revision: number
  rows: Array<TItem>
  outbox: Array<NotionOutboxEntry<TItem>>
  lastSyncedAt: number | null
  remoteWatermark?: string | undefined
  lastFullReconciledAt?: number | undefined
  remoteVersion?: number | undefined
  pagination?: NotionRemotePaginationState | undefined
}

export type NotionPersistedEnvelope<TItem extends object> =
  | LegacyNotionPersistedState<TItem>
  | NotionPersistedState<TItem>

export interface NotionQuarantineRecord {
  collectionId: string
  quarantinedAt: string
  reason: string
  value: unknown
}

export interface NotionStorageLockOptions {
  signal?: AbortSignal
  leaseMs?: number
  acquireTimeoutMs?: number
}

export interface NotionCollectionStorage {
  readonly kind:
    | 'indexeddb'
    | 'localstorage'
    | 'memory'
    | 'custom'
    | 'unavailable'
  load: <TItem extends object>(
    collectionId: string,
  ) => Promise<NotionPersistedEnvelope<TItem> | null>
  save: <TItem extends object>(
    collectionId: string,
    state: NotionPersistedState<TItem>,
  ) => Promise<void>
  clear: (collectionId: string) => Promise<void>
  compareAndSet?: <TItem extends object>(
    collectionId: string,
    expectedRevision: number,
    state: NotionPersistedState<TItem>,
  ) => Promise<boolean>
  quarantine?: (
    collectionId: string,
    value: unknown,
    reason: string,
  ) => Promise<NotionQuarantineRecord>
  loadQuarantine?: (
    collectionId: string,
  ) => Promise<NotionQuarantineRecord | null>
  clearQuarantine?: (collectionId: string) => Promise<void>
  runExclusive?: <T>(
    collectionId: string,
    ownerId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options?: NotionStorageLockOptions,
  ) => Promise<T>
}

export interface NotionPersistedStateStore<TItem extends object> {
  readonly revision: number
  reload: () => Promise<NotionPersistedEnvelope<TItem> | null>
  loadQuarantine: () => Promise<NotionQuarantineRecord | null>
  clearQuarantine: () => Promise<void>
  saveReset: (state: NotionPersistedState<TItem>) => Promise<void>
  compareAndSet: (
    state: NotionPersistedState<TItem>,
  ) => Promise<boolean>
  compareAndSetWithRetry: (
    createState: (
      revision: number,
    ) => NotionPersistedState<TItem>,
    onConflict: (
      persisted: NotionPersistedEnvelope<TItem> | null,
    ) => Promise<void>,
    onExhausted: () => Error,
  ) => Promise<void>
}

export function createNotionPersistedStateStore<TItem extends object>(
  storage: NotionCollectionStorage,
  storageId: string,
): NotionPersistedStateStore<TItem> {
  let revision = 0
  return {
    get revision() {
      return revision
    },
    async reload() {
      const quarantine = await this.loadQuarantine()
      if (quarantine) throw new NotionPersistedStateError(quarantine.reason)
      const persisted = await storage.load<TItem>(storageId)
      revision = persisted?.version === 2 ? persisted.revision : 0
      return persisted
    },
    async loadQuarantine() {
      return (await storage.loadQuarantine?.(storageId)) ?? null
    },
    async clearQuarantine() {
      await storage.clearQuarantine?.(storageId)
    },
    async saveReset(state) {
      await storage.save(storageId, state)
      revision = state.revision
    },
    async compareAndSet(state) {
      const saved = storage.compareAndSet
        ? await storage.compareAndSet(storageId, revision, state)
        : await storage.save(storageId, state).then(() => true)
      if (saved) revision = state.revision
      return saved
    },
    async compareAndSetWithRetry(createState, onConflict, onExhausted) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (await this.compareAndSet(createState(revision))) return
        await onConflict(await this.reload())
      }
      throw onExhausted()
    },
  }
}
