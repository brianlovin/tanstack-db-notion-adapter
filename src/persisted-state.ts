import { createSerializedQueue } from './browser-sync-runtime.js'
import type {
  NotionCollectionStorage,
  NotionPersistedEnvelope,
  NotionPersistedState,
} from './client.js'

export { createSerializedQueue }

export class NotionPersistedStateError extends Error {
  readonly code = 'persisted_state_quarantined'

  constructor(message: string) {
    super(message)
    this.name = 'NotionPersistedStateError'
  }
}

export interface NotionPersistedStateStore<TItem extends object> {
  readonly revision: number
  reload: () => Promise<NotionPersistedEnvelope<TItem> | null>
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
      const quarantine = (await storage.loadQuarantine?.(storageId)) ?? null
      if (quarantine) throw new NotionPersistedStateError(quarantine.reason)
      const persisted = await storage.load<TItem>(storageId)
      revision = persisted?.version === 2 ? persisted.revision : 0
      return persisted
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
