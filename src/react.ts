import { useEffect, useSyncExternalStore } from 'react'
import type {
  NotionCollectionUtils,
  NotionSyncState,
} from './client.js'
import type {
  NotionPageContentClient,
  NotionPageContentSnapshot,
} from './content-client.js'

const serverSyncState: NotionSyncState = {
  status: 'idle',
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: 'unavailable',
  error: null,
  quarantine: null,
}

export interface NotionSyncStateCollection<TItem extends object> {
  readonly utils: Pick<
    NotionCollectionUtils<TItem>,
    'getSyncState' | 'subscribeSyncState'
  >
}

/** Subscribes to adapter sync state with a stable server-rendering fallback. */
export function useNotionSyncState<TItem extends object>(
  collection: NotionSyncStateCollection<TItem>,
): NotionSyncState {
  return useSyncExternalStore(
    collection.utils.subscribeSyncState,
    collection.utils.getSyncState,
    () => serverSyncState,
  )
}

/** Subscribes to one lazily loaded page body and remains safe during SSR. */
export function useNotionPageContent(
  client: NotionPageContentClient,
  key: string | null,
): NotionPageContentSnapshot | undefined {
  const snapshot = useSyncExternalStore(
    client.subscribe,
    () => (key ? client.get(key) : undefined),
    () => undefined,
  )
  useEffect(() => {
    if (!key) return
    return client.watch(key)
  }, [client, key])
  return snapshot
}
