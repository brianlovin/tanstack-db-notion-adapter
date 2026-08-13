import {
  createBrowserSyncLifecycle,
  createJsonRequester,
  NotionSyncError,
} from './browser-sync-runtime.js'
import {
  createNotionStorageId,
  createNotionPersistedStateStore,
  createSerializedQueue,
} from './persisted-state.js'
import {
  createBrowserNotionStorage,
  type NotionCollectionStorage,
  type NotionPersistedState,
} from './client.js'
import type { NotionInvalidationVersion, NotionPageContent } from './protocol.js'

export type NotionPageContentStatus =
  | 'idle'
  | 'loading'
  | 'saved-local'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'error'

export type NotionPageContentReadOnlyReason =
  | 'page_content_incomplete'
  | 'page_content_conflict'

export interface NotionPageContentConflict {
  localMarkdown: string
  remoteMarkdown: string
  allowedActions: ['accept-remote', 'overwrite-remote']
}

export interface NotionPageContentSnapshot {
  /** Stable local key, normally the row's `notion.id()` value. */
  key: string
  /** Assigned by Notion after a new offline row reaches the server. */
  notionPageId: string | null
  markdown: string
  baseMarkdown: string
  remoteMarkdown: string | null
  revision: number
  pending: boolean
  truncated: boolean
  unknownBlockIds: Array<string>
  status: NotionPageContentStatus
  lastSyncedAt: number | null
  error: string | null
  editable: boolean
  readOnlyReason: NotionPageContentReadOnlyReason | null
  conflict: NotionPageContentConflict | null
}

export interface NotionPageContentCollection<TItem extends object> {
  readonly config: {
    readonly schema?: {
      getKey: (row: TItem) => string
      getPageId: (row: TItem) => string | null
    }
  }
  values: () => IterableIterator<TItem>
  subscribeChanges: (listener: () => void) => { unsubscribe: () => void }
}

export interface NotionPageContentClientConfig<
  TItem extends object = Record<string, unknown>,
> {
  id: string
  /** Immutable account/workspace namespace shared with the row collection. */
  storageScope?: string
  endpoint: string
  /** Automatically attaches drafts when synced rows receive a Notion page ID. */
  collection?: NotionPageContentCollection<TItem>
  storage?: NotionCollectionStorage
  fetch?: typeof globalThis.fetch
  /** Wait after the latest local edit before flushing to Notion. @default 750 */
  debounceMs?: number
  /** Abort a content request after this interval. @default 30000 */
  requestTimeoutMs?: number
  /** Refresh watched page bodies at this interval. Set to 0 to disable. @default 60000 */
  pollIntervalMs?: number
  /** Refresh watched page bodies when the app window regains focus. @default true */
  refreshOnWindowFocus?: boolean
  /** Poll webhook invalidation state and refresh watched pages when it changes. @default 0 */
  invalidationPollIntervalMs?: number
  isOnline?: () => boolean
  /** Wait for authentication before automatically flushing pending drafts. */
  autoStart?: boolean
}

export interface NotionPageContentClient {
  readonly storage: NotionCollectionStorage['kind']
  ready: () => Promise<void>
  resumeSync: () => Promise<void>
  pauseSync: () => void
  get: (key: string) => NotionPageContentSnapshot | undefined
  subscribe: (listener: () => void) => () => void
  /** Creates a durable local draft. Call this before inserting a new row. */
  createDraft: (key: string, initialMarkdown?: string) => Promise<void>
  /** Deletes one durable local content record without changing Notion. */
  discardDraft: (
    key: string,
    options: { acceptDataLoss: true },
  ) => Promise<void>
  /** Fetches and merges a known page. Prefer attachPage for editable content. */
  load: (key: string, notionPageId: string) => Promise<NotionPageContentSnapshot>
  /** Creates a missing draft, loads the page, and schedules pending content. */
  attachPage: (key: string, notionPageId: string) => Promise<void>
  /** Revalidates one attached page body against Notion. */
  refresh: (key: string) => Promise<NotionPageContentSnapshot>
  /** Marks a page as active for focus, polling, and webhook revalidation. */
  watch: (key: string) => () => void
  update: (key: string, markdown: string) => Promise<void>
  flush: (key: string) => Promise<void>
  flushAll: () => Promise<void>
  acceptRemote: (key: string) => Promise<void>
  overwriteRemote: (
    key: string,
    options: { acceptDataLoss: true },
  ) => Promise<void>
  cleanup: () => void
}

function clone<T>(value: T): T {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)
}

type NotionPageContentSnapshotRecord = Omit<
  NotionPageContentSnapshot,
  'editable' | 'readOnlyReason' | 'conflict'
> &
  Partial<
    Pick<
      NotionPageContentSnapshot,
      'editable' | 'readOnlyReason' | 'conflict'
    >
  >

function withContentCapabilities(
  value: NotionPageContentSnapshotRecord,
): NotionPageContentSnapshot {
  const incomplete =
    value.truncated ||
    value.unknownBlockIds.length > 0 ||
    value.markdown.includes('<unknown ')
  const conflict =
    value.remoteMarkdown === null
      ? null
      : {
          localMarkdown: value.markdown,
          remoteMarkdown: value.remoteMarkdown,
          allowedActions: [
            'accept-remote',
            'overwrite-remote',
          ] as NotionPageContentConflict['allowedActions'],
        }
  const readOnlyReason: NotionPageContentReadOnlyReason | null = incomplete
    ? 'page_content_incomplete'
    : conflict || value.status === 'conflict'
      ? 'page_content_conflict'
      : null
  return {
    ...value,
    editable: readOnlyReason === null,
    readOnlyReason,
    conflict,
  }
}

function emptyPersistedState(): NotionPersistedState<NotionPageContentSnapshot> {
  return { version: 2, revision: 0, rows: [], outbox: [], lastSyncedAt: null }
}

function isSnapshot(value: unknown): value is NotionPageContentSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<NotionPageContentSnapshot>
  return (
    typeof snapshot.key === 'string' &&
    (snapshot.notionPageId === null ||
      typeof snapshot.notionPageId === 'string') &&
    typeof snapshot.markdown === 'string' &&
    typeof snapshot.baseMarkdown === 'string' &&
    typeof snapshot.revision === 'number' &&
    typeof snapshot.pending === 'boolean' &&
    typeof snapshot.truncated === 'boolean' &&
    Array.isArray(snapshot.unknownBlockIds)
  )
}

function randomId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

/**
 * Creates a lazy, durable page-content client for Notion's enhanced-markdown
 * API. Drafts commit to browser storage immediately; only remote writes are
 * debounced and coalesced.
 */
export function createNotionPageContentClient<
  TItem extends object = Record<string, unknown>,
>(
  config: NotionPageContentClientConfig<TItem>,
): NotionPageContentClient {
  const storage = config.storage ?? createBrowserNotionStorage()
  const fetcher = config.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetcher) throw new Error('A fetch implementation is required.')

  const endpoint = config.endpoint.replace(/\/$/, '')
  const storageId = `${createNotionStorageId(
    config.id,
    config.storageScope,
  )}:page-content`
  const persistence = createNotionPersistedStateStore<
    NotionPageContentSnapshot
  >(storage, storageId)
  const debounceMs = Math.max(0, config.debounceMs ?? 750)
  const requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000)
  const pollIntervalMs = Math.max(0, config.pollIntervalMs ?? 60_000)
  const invalidationPollIntervalMs = Math.max(
    0,
    config.invalidationPollIntervalMs ?? 0,
  )
  const listeners = new Set<() => void>()
  const watchedKeys = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const flushQueues = new Map<string, Promise<void>>()
  const attachmentQueue = createSerializedQueue()
  const refreshQueue = createSerializedQueue()
  const operationQueue = createSerializedQueue()
  let collectionSubscription: { unsubscribe: () => void } | undefined
  let invalidationVersion: number | null = null
  let records = new Map<string, NotionPageContentSnapshot>()
  let disposed = false
  let syncEnabled = config.autoStart !== false
  const lifecycle = createBrowserSyncLifecycle({
    ...(config.isOnline ? { isOnline: config.isOnline } : {}),
    ...(config.refreshOnWindowFocus === undefined
      ? {}
      : { refreshOnWindowFocus: config.refreshOnWindowFocus }),
    focusMode: 'window',
    pollIntervalMs,
    invalidationPollIntervalMs,
    onOnline: () => handleOnline(),
    onFocus: () => handleFocus(),
    onInvalidationPoll: () => {
      void checkForRemoteChanges().catch(() => undefined)
    },
  })
  const online = lifecycle.online
  const requestJson = createJsonRequester({
    fetch: fetcher,
    lifecycleSignal: lifecycle.signal,
    timeoutMs: requestTimeoutMs,
    timeoutMessage: 'The page-content request timed out.',
  })

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Subscriber failures must never change a persistence outcome.
      }
    }
  }

  const exclusive = operationQueue.run

  const persist = async (next: Map<string, NotionPageContentSnapshot>) => {
    const previous = records
    let desired = new Map(
      [...next].map(([key, value]) => [key, withContentCapabilities(value)]),
    )
    try {
      await persistence.compareAndSetWithRetry(
        () => {
        const lastSyncedAt = [...desired.values()].reduce<number | null>(
          (latest, record) =>
            record.lastSyncedAt !== null &&
            (latest === null || record.lastSyncedAt > latest)
              ? record.lastSyncedAt
              : latest,
          null,
        )
        const state: NotionPersistedState<NotionPageContentSnapshot> = {
          ...emptyPersistedState(),
          revision: persistence.revision + 1,
          rows: [...desired.values()],
          lastSyncedAt,
        }
          return state
        },
        async (persisted) => {
          const reloaded = new Map<string, NotionPageContentSnapshot>()
          for (const value of persisted?.rows ?? []) {
            if (isSnapshot(value)) {
              reloaded.set(value.key, withContentCapabilities(value))
            }
          }
          const merged = new Map(reloaded)
          for (const [key, value] of previous) {
            const local = desired.get(key)
            if (JSON.stringify(local) === JSON.stringify(value)) continue
            if (local === undefined) merged.delete(key)
            else merged.set(key, local)
          }
          for (const [key, local] of desired) {
            if (previous.has(key)) continue
            merged.set(key, local)
          }
          records = merged
          desired = merged
        },
        () =>
          new NotionSyncError({
            code: 'storage_revision_conflict',
            message: 'Another tab saved a newer page-content draft.',
          }),
      )
      records = desired
      notify()
    } catch (error) {
      records = desired
      notify()
      throw error
    }
  }

  const initialization = (async () => {
    const persisted = await persistence.reload()
    if (disposed || !persisted) return
    const next = new Map<string, NotionPageContentSnapshot>()
    for (const value of persisted.rows) {
      if (!isSnapshot(value)) {
        const reason = 'A persisted page-content draft is malformed.'
        await storage.quarantine?.(storageId, persisted, reason)
        throw new NotionSyncError({
          code: 'persisted_state_quarantined',
          message: reason,
          retryable: false,
        })
      }
      const remoteMarkdown =
        typeof value.remoteMarkdown === 'string' ? value.remoteMarkdown : null
      let status: NotionPageContentStatus = 'idle'
      if (remoteMarkdown !== null || value.status === 'conflict') {
        status = 'conflict'
      } else if (value.pending) {
        status = online() ? 'saved-local' : 'offline'
      }
      next.set(
        value.key,
        withContentCapabilities({
          ...value,
          remoteMarkdown,
          unknownBlockIds: value.unknownBlockIds.filter(
            (id): id is string => typeof id === 'string',
          ),
          status,
          error: null,
        }),
      )
    }
    records = next
    if (persisted.version === 1) await persist(next)
    notify()
  })()

  const attachAvailablePages = (): Promise<void> => {
    const run = async () => {
      await initialization
      const collection = config.collection
      const schema = collection?.config.schema
      if (!collection || !schema || disposed || !syncEnabled) return
      for (const row of collection.values()) {
        const key = schema.getKey(row)
        const notionPageId = schema.getPageId(row)
        const draft = records.get(key)
        if (!notionPageId || !draft || draft.notionPageId !== null) continue
        await client.attachPage(key, notionPageId)
      }
    }
    return attachmentQueue.run(run)
  }

  const fetchRemote = async (
    notionPageId: string,
  ): Promise<NotionPageContent> => {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://localhost')
    url.searchParams.set('action', 'content')
    url.searchParams.set('pageId', notionPageId)
    return requestJson<NotionPageContent>(url.toString())
  }

  const refreshWatched = (): Promise<void> => {
    const run = async () => {
      await initialization
      if (disposed || !syncEnabled || !online()) return
      for (const key of watchedKeys.keys()) {
        const record = records.get(key)
        if (
          !record?.notionPageId ||
          record.pending ||
          record.status === 'conflict' ||
          record.status === 'loading' ||
          record.status === 'syncing'
        ) {
          continue
        }
        await client.refresh(key).catch(() => undefined)
      }
    }
    return refreshQueue.run(run)
  }

  const checkForRemoteChanges = async (): Promise<void> => {
    if (disposed || !syncEnabled || !online()) return
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://localhost')
    url.searchParams.set('action', 'version')
    const current = await requestJson<NotionInvalidationVersion>(url.toString())
    if (invalidationVersion === null) {
      invalidationVersion = current.version
      await refreshWatched()
      return
    }
    if (current.version === invalidationVersion) return
    invalidationVersion = current.version
    await refreshWatched()
  }

  const schedule = (key: string, delay = debounceMs) => {
    if (!syncEnabled) return
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        void flush(key).catch(() => undefined)
      }, delay),
    )
  }

  const mergeRemote = async (
    key: string,
    notionPageId: string,
    remote: NotionPageContent,
  ): Promise<NotionPageContentSnapshot> =>
    exclusive(async () => {
      const current = records.get(key)
      let nextRecord: NotionPageContentSnapshot
      if (!current || !current.pending) {
        nextRecord = withContentCapabilities({
          key,
          notionPageId,
          markdown: remote.markdown,
          baseMarkdown: remote.markdown,
          remoteMarkdown: null,
          revision: current?.revision ?? 0,
          pending: false,
          truncated: remote.truncated,
          unknownBlockIds: remote.unknownBlockIds,
          status: 'synced',
          lastSyncedAt: Date.now(),
          error: null,
        })
      } else if (current.markdown === remote.markdown) {
        nextRecord = withContentCapabilities({
          ...current,
          notionPageId,
          baseMarkdown: remote.markdown,
          remoteMarkdown: null,
          pending: false,
          truncated: remote.truncated,
          unknownBlockIds: remote.unknownBlockIds,
          status: 'synced',
          lastSyncedAt: Date.now(),
          error: null,
        })
      } else if (current.baseMarkdown === remote.markdown) {
        nextRecord = withContentCapabilities({
          ...current,
          notionPageId,
          truncated: remote.truncated,
          unknownBlockIds: remote.unknownBlockIds,
          status: online() ? 'saved-local' : 'offline',
          error: null,
        })
      } else {
        nextRecord = withContentCapabilities({
          ...current,
          notionPageId,
          remoteMarkdown: remote.markdown,
          truncated: remote.truncated,
          unknownBlockIds: remote.unknownBlockIds,
          status: 'conflict',
          error: 'This page changed in Notion while a local draft was pending.',
        })
      }
      const next = new Map(records)
      next.set(key, nextRecord)
      await persist(next)
      return clone(nextRecord)
    })

  const performFlush = async (key: string): Promise<void> => {
    await initialization
    if (disposed) return
    const current = records.get(key)
    if (!current?.pending || current.status === 'conflict') return
    if (!current.notionPageId) return
    if (!online()) {
      await exclusive(async () => {
        const latest = records.get(key)
        if (!latest?.pending) return
        const next = new Map(records)
        next.set(key, { ...latest, status: 'offline', error: null })
        await persist(next)
      })
      return
    }

    const revision = current.revision
    const notionPageId = current.notionPageId
    await exclusive(async () => {
      const latest = records.get(key)
      if (!latest || latest.revision !== revision) return
      const next = new Map(records)
      next.set(key, { ...latest, status: 'syncing', error: null })
      await persist(next)
    })

    let remote: NotionPageContent
    try {
      remote = await requestJson<NotionPageContent>(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'page_content',
          idempotencyKey: `${notionPageId}:${revision}:${randomId()}`,
          pageId: notionPageId,
          baseMarkdown: current.baseMarkdown,
          markdown: current.markdown,
        }),
      })
    } catch (error) {
      if (disposed) return
      if (error instanceof NotionSyncError && error.code === 'page_content_conflict') {
        try {
          await mergeRemote(
            key,
            notionPageId,
            await fetchRemote(notionPageId),
          )
          return
        } catch {
          // Keep the original conflict below if the follow-up read also fails.
        }
      }
      await exclusive(async () => {
        const latest = records.get(key)
        if (!latest?.pending) return
        const next = new Map(records)
        let status: NotionPageContentStatus = online() ? 'error' : 'offline'
        if (
          error instanceof NotionSyncError &&
          error.code === 'page_content_conflict'
        ) {
          status = 'conflict'
        }
        next.set(
          key,
          withContentCapabilities({
            ...latest,
            status,
            error:
              error instanceof Error ? error.message : 'Content sync failed.',
          }),
        )
        await persist(next)
      })
      throw error
    }

    if (disposed) return

    let shouldSchedule = false
    await exclusive(async () => {
      const latest = records.get(key)
      if (!latest) return
      const next = new Map(records)
      if (latest.revision === revision) {
        next.set(
          key,
          withContentCapabilities({
            ...latest,
            markdown: remote.markdown,
            baseMarkdown: remote.markdown,
            remoteMarkdown: null,
            pending: false,
            truncated: remote.truncated,
            unknownBlockIds: remote.unknownBlockIds,
            status: 'synced',
            lastSyncedAt: Date.now(),
            error: null,
          }),
        )
      } else {
        shouldSchedule = true
        next.set(key, {
          ...latest,
          baseMarkdown: remote.markdown,
          remoteMarkdown: null,
          status: online() ? 'saved-local' : 'offline',
          lastSyncedAt: Date.now(),
          error: null,
        })
      }
      await persist(next)
    })
    if (shouldSchedule) schedule(key)
  }

  const flush = (key: string): Promise<void> => {
    const previous = flushQueues.get(key) ?? Promise.resolve()
    const result = previous.then(
      () => performFlush(key),
      () => performFlush(key),
    )
    const tracked = result.finally(() => {
      if (flushQueues.get(key) === tracked) flushQueues.delete(key)
    })
    flushQueues.set(key, tracked)
    return tracked
  }

  const handleOnline = () => {
    if (!syncEnabled) return
    void client
      .flushAll()
      .then(refreshWatched)
      .catch(() => undefined)
  }

  const handleFocus = () => {
    void refreshWatched().catch(() => undefined)
  }

  const client: NotionPageContentClient = {
    get storage() {
      return storage.kind
    },
    ready: () => initialization,
    async resumeSync() {
      syncEnabled = true
      await client.flushAll()
      await refreshWatched()
    },
    pauseSync() {
      syncEnabled = false
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
    get(key) {
      return records.get(key)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async createDraft(key, initialMarkdown = '') {
      await initialization
      await exclusive(async () => {
        if (records.has(key)) return
        const next = new Map(records)
        next.set(
          key,
          withContentCapabilities({
            key,
            notionPageId: null,
            markdown: initialMarkdown,
            baseMarkdown: '',
            remoteMarkdown: null,
            revision: initialMarkdown ? 1 : 0,
            pending: initialMarkdown.length > 0,
            truncated: false,
            unknownBlockIds: [],
            status: online() ? 'saved-local' : 'offline',
            lastSyncedAt: null,
            error: null,
          }),
        )
        await persist(next)
      })
      await attachAvailablePages()
    },
    async discardDraft(key, options) {
      if (options.acceptDataLoss !== true) {
        throw new NotionSyncError({
          code: 'data_loss_not_accepted',
          message: 'Discarding a page-content draft requires acceptDataLoss: true.',
          retryable: false,
        })
      }
      await initialization
      const timer = timers.get(key)
      if (timer) clearTimeout(timer)
      timers.delete(key)
      await exclusive(async () => {
        if (!records.has(key)) return
        const next = new Map(records)
        next.delete(key)
        await persist(next)
      })
    },
    async load(key, notionPageId) {
      await initialization
      await exclusive(async () => {
        const current = records.get(key)
        if (current && current.notionPageId !== notionPageId) {
          const next = new Map(records)
          next.set(key, { ...current, notionPageId })
          await persist(next)
        }
      })
      if (!online()) {
        const cached = records.get(key)
        if (cached) return clone(cached)
        throw new NotionSyncError({
          code: 'content_not_cached',
          message: 'This page has not been opened yet and is unavailable offline.',
          retryable: true,
        })
      }
      await exclusive(async () => {
        const current = records.get(key)
        if (!current || !current.pending) {
          const next = new Map(records)
          next.set(
            key,
            withContentCapabilities({
              key,
              notionPageId,
              markdown: current?.markdown ?? '',
              baseMarkdown: current?.baseMarkdown ?? '',
              remoteMarkdown: current?.remoteMarkdown ?? null,
              revision: current?.revision ?? 0,
              pending: current?.pending ?? false,
              truncated: current?.truncated ?? false,
              unknownBlockIds: current?.unknownBlockIds ?? [],
              status: 'loading',
              lastSyncedAt: current?.lastSyncedAt ?? null,
              error: null,
            }),
          )
          await persist(next)
        }
      })
      return mergeRemote(
        key,
        notionPageId,
        await fetchRemote(notionPageId),
      )
    },
    async attachPage(key, notionPageId) {
      await initialization
      const createdDraft = !records.has(key)
      if (createdDraft) await client.createDraft(key)
      if (!createdDraft || records.get(key)?.notionPageId !== notionPageId) {
        await client.load(key, notionPageId)
      }
      const attached = records.get(key)
      if (attached?.pending && attached.status !== 'conflict') schedule(key, 0)
    },
    async refresh(key) {
      await initialization
      const current = records.get(key)
      if (!current?.notionPageId) {
        throw new NotionSyncError({
          code: 'content_not_attached',
          message: 'Attach the page before refreshing its content.',
          retryable: false,
        })
      }
      if (!online()) return clone(current)
      return mergeRemote(
        key,
        current.notionPageId,
        await fetchRemote(current.notionPageId),
      )
    },
    watch(key) {
      watchedKeys.set(key, (watchedKeys.get(key) ?? 0) + 1)
      let watching = true
      return () => {
        if (!watching) return
        watching = false
        const count = watchedKeys.get(key) ?? 0
        if (count <= 1) watchedKeys.delete(key)
        else watchedKeys.set(key, count - 1)
      }
    },
    async update(key, markdown) {
      await initialization
      if (!records.has(key)) {
        const collection = config.collection
        const schema = collection?.config.schema
        const row = schema
          ? [...(collection?.values() ?? [])].find(
              (value) => schema.getKey(value) === key,
            )
          : undefined
        const notionPageId = row && schema?.getPageId(row)
        if (notionPageId) await client.load(key, notionPageId)
      }
      await exclusive(async () => {
        const current = records.get(key)
        if (!current) {
          throw new NotionSyncError({
            code: 'content_not_loaded',
            message: 'Load the page before editing its content.',
            retryable: false,
          })
        }
        if (!current.editable) {
          throw new NotionSyncError({
            code: current.readOnlyReason ?? 'page_content_incomplete',
            message:
              current.readOnlyReason === 'page_content_conflict'
                ? 'Resolve the page-content conflict before editing.'
                : 'This page contains content that cannot be edited safely as markdown.',
            retryable: false,
          })
        }
        if (current.markdown === markdown) return
        const next = new Map(records)
        next.set(key, {
          ...current,
          markdown,
          revision: current.revision + 1,
          pending: true,
          status: online() ? 'saved-local' : 'offline',
          error: null,
        })
        await persist(next)
      })
      schedule(key)
    },
    flush,
    async flushAll() {
      await initialization
      await attachAvailablePages()
      const flushes: Array<Promise<void>> = []
      for (const record of records.values()) {
        if (
          record.pending &&
          record.notionPageId !== null &&
          record.status !== 'conflict'
        ) {
          flushes.push(flush(record.key))
        }
      }
      await Promise.all(flushes)
    },
    async acceptRemote(key) {
      await initialization
      await exclusive(async () => {
        const current = records.get(key)
        if (!current || current.remoteMarkdown === null) {
          throw new NotionSyncError({
            code: 'content_conflict_not_found',
            message: 'There is no remote conflict to accept.',
            retryable: false,
          })
        }
        const next = new Map(records)
        next.set(key, {
          ...current,
          markdown: current.remoteMarkdown,
          baseMarkdown: current.remoteMarkdown,
          remoteMarkdown: null,
          revision: current.revision + 1,
          pending: false,
          status: 'synced',
          lastSyncedAt: Date.now(),
          error: null,
        })
        await persist(next)
      })
    },
    async overwriteRemote(key, options) {
      await initialization
      if (options.acceptDataLoss !== true) {
        throw new NotionSyncError({
          code: 'data_loss_not_accepted',
          message: 'Overwriting remote content requires acceptDataLoss: true.',
          retryable: false,
        })
      }
      await exclusive(async () => {
        const current = records.get(key)
        if (!current || current.remoteMarkdown === null) {
          throw new NotionSyncError({
            code: 'content_conflict_not_found',
            message: 'There is no remote conflict to overwrite.',
            retryable: false,
          })
        }
        const next = new Map(records)
        next.set(key, {
          ...current,
          baseMarkdown: current.remoteMarkdown,
          remoteMarkdown: null,
          pending: true,
          status: online() ? 'saved-local' : 'offline',
          error: null,
        })
        await persist(next)
      })
      await flush(key)
    },
    cleanup() {
      disposed = true
      lifecycle.dispose(new Error('The page-content client was disposed.'))
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      watchedKeys.clear()
      listeners.clear()
      collectionSubscription?.unsubscribe()
    },
  }

  lifecycle.start()
  collectionSubscription = config.collection?.subscribeChanges(() => {
    void attachAvailablePages().catch(() => undefined)
  })

  void initialization
    .then(() => {
      void attachAvailablePages().catch(() => undefined)
      if (!disposed && syncEnabled && online()) {
        for (const record of records.values()) {
          if (
            record.pending &&
            record.notionPageId !== null &&
            record.status !== 'conflict'
          ) {
            schedule(record.key)
          }
        }
      }
    })
    .catch(() => undefined)

  return client
}
