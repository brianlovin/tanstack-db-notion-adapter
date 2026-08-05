import type { NotionErrorBody, NotionPageContent } from './protocol.js'
import {
  createBrowserNotionStorage,
  NotionSyncError,
  type NotionCollectionStorage,
  type NotionPersistedState,
} from './client.js'

export type NotionPageContentStatus =
  | 'idle'
  | 'loading'
  | 'saved-local'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'error'

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
}

export interface NotionPageContentClientConfig {
  id: string
  endpoint: string
  storage?: NotionCollectionStorage
  fetch?: typeof globalThis.fetch
  /** Wait after the latest local edit before flushing to Notion. @default 750 */
  debounceMs?: number
  /** Abort a content request after this interval. @default 30000 */
  requestTimeoutMs?: number
  isOnline?: () => boolean
}

export interface NotionPageContentClient {
  readonly storage: NotionCollectionStorage['kind']
  ready: () => Promise<void>
  get: (key: string) => NotionPageContentSnapshot | undefined
  subscribe: (listener: () => void) => () => void
  createDraft: (key: string, initialMarkdown?: string) => Promise<void>
  load: (key: string, notionPageId: string) => Promise<NotionPageContentSnapshot>
  attachPage: (key: string, notionPageId: string) => Promise<void>
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
export function createNotionPageContentClient(
  config: NotionPageContentClientConfig,
): NotionPageContentClient {
  const storage = config.storage ?? createBrowserNotionStorage()
  const fetcher = config.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('A fetch implementation is required.')

  const endpoint = config.endpoint.replace(/\/$/, '')
  const storageId = `${config.id}:page-content`
  const debounceMs = Math.max(0, config.debounceMs ?? 750)
  const requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000)
  const listeners = new Set<() => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const flushQueues = new Map<string, Promise<void>>()
  const online = () =>
    config.isOnline?.() ??
    (typeof navigator === 'undefined' || navigator.onLine !== false)
  let records = new Map<string, NotionPageContentSnapshot>()
  let operationQueue = Promise.resolve()
  let disposed = false
  let storageRevision = 0
  const lifecycle = new AbortController()

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Subscriber failures must never change a persistence outcome.
      }
    }
  }

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const persist = async (next: Map<string, NotionPageContentSnapshot>) => {
    const lastSyncedAt = [...next.values()].reduce<number | null>(
      (latest, record) =>
        record.lastSyncedAt !== null &&
        (latest === null || record.lastSyncedAt > latest)
          ? record.lastSyncedAt
          : latest,
      null,
    )
    const state: NotionPersistedState<NotionPageContentSnapshot> = {
      ...emptyPersistedState(),
      revision: storageRevision + 1,
      rows: [...next.values()],
      lastSyncedAt,
    }
    const saved = storage.compareAndSet
      ? await storage.compareAndSet(storageId, storageRevision, state)
      : await storage.save(storageId, state).then(() => true)
    if (!saved) {
      throw new NotionSyncError({
        code: 'storage_revision_conflict',
        message: 'Another tab saved a newer page-content draft.',
      })
    }
    storageRevision = state.revision
    records = next
    notify()
  }

  const initialization = (async () => {
    const persisted = await storage.load<NotionPageContentSnapshot>(storageId)
    if (disposed || !persisted) return
    storageRevision = persisted.version === 2 ? persisted.revision : 0
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
      let status: NotionPageContentStatus = 'idle'
      if (value.pending) status = online() ? 'saved-local' : 'offline'
      next.set(value.key, {
        ...value,
        remoteMarkdown:
          typeof value.remoteMarkdown === 'string' ? value.remoteMarkdown : null,
        unknownBlockIds: value.unknownBlockIds.filter(
          (id): id is string => typeof id === 'string',
        ),
        status,
        error: null,
      })
    }
    records = next
    if (persisted.version === 1) await persist(next)
    notify()
  })()

  const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(lifecycle.signal.reason)
    if (lifecycle.signal.aborted) abort()
    else lifecycle.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, requestTimeoutMs)
    let response: Response
    try {
      response = await fetcher(url, { ...init, signal: controller.signal })
    } catch (error) {
      let message = 'The network request failed.'
      if (timedOut) message = 'The page-content request timed out.'
      else if (error instanceof Error) message = error.message
      throw new NotionSyncError({
        code: timedOut ? 'request_timeout' : 'network_error',
        message,
      })
    } finally {
      clearTimeout(timeout)
      lifecycle.signal.removeEventListener('abort', abort)
    }

    const body = (await response.json().catch(() => ({}))) as T | NotionErrorBody
    if (!response.ok) {
      const error = (body as NotionErrorBody).error
      throw new NotionSyncError({
        status: response.status,
        code: error?.code ?? `http_${response.status}`,
        message: error?.message ?? `The sync server returned HTTP ${response.status}.`,
        retryable: error?.retryable ?? response.status >= 500,
      })
    }
    return body as T
  }

  const fetchRemote = async (
    notionPageId: string,
  ): Promise<NotionPageContent> => {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://localhost')
    url.searchParams.set('action', 'content')
    url.searchParams.set('pageId', notionPageId)
    return requestJson<NotionPageContent>(url.toString())
  }

  const schedule = (key: string, delay = debounceMs) => {
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
        nextRecord = {
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
        }
      } else if (current.markdown === remote.markdown) {
        nextRecord = {
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
        }
      } else if (current.baseMarkdown === remote.markdown) {
        nextRecord = {
          ...current,
          notionPageId,
          truncated: remote.truncated,
          unknownBlockIds: remote.unknownBlockIds,
          status: online() ? 'saved-local' : 'offline',
          error: null,
        }
      } else {
        nextRecord = {
          ...current,
          notionPageId,
          remoteMarkdown: remote.markdown,
          truncated: remote.truncated,
          unknownBlockIds: remote.unknownBlockIds,
          status: 'conflict',
          error: 'This page changed in Notion while a local draft was pending.',
        }
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
        next.set(key, {
          ...latest,
          status,
          error: error instanceof Error ? error.message : 'Content sync failed.',
        })
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
        next.set(key, {
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
        })
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
    void client.flushAll().catch(() => undefined)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
  }

  const client: NotionPageContentClient = {
    get storage() {
      return storage.kind
    },
    ready: () => initialization,
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
        next.set(key, {
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
        })
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
          next.set(key, {
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
          })
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
      if (!records.has(key)) await client.createDraft(key)
      await client.load(key, notionPageId)
      const current = records.get(key)
      if (current?.pending && current.status !== 'conflict') schedule(key, 0)
    },
    async update(key, markdown) {
      await initialization
      await exclusive(async () => {
        const current = records.get(key)
        if (!current) {
          throw new NotionSyncError({
            code: 'content_not_loaded',
            message: 'Load the page before editing its content.',
            retryable: false,
          })
        }
        if (
          current.truncated ||
          current.unknownBlockIds.length > 0 ||
          current.markdown.includes('<unknown ')
        ) {
          throw new NotionSyncError({
            code: 'page_content_incomplete',
            message:
              'This page contains content that cannot be edited safely as markdown.',
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
      lifecycle.abort(new Error('The page-content client was disposed.'))
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      listeners.clear()
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline)
      }
    },
  }

  void initialization
    .then(() => {
      if (!disposed && online()) {
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
