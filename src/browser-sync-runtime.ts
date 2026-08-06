import type { NotionErrorBody, NotionPropertyConflict } from './protocol.js'

export class NotionSyncError extends Error {
  readonly status: number | null
  readonly code: string
  readonly retryable: boolean
  readonly conflicts: ReadonlyArray<NotionPropertyConflict>

  constructor(options: {
    message: string
    code?: string
    status?: number | null
    retryable?: boolean
    conflicts?: ReadonlyArray<NotionPropertyConflict>
  }) {
    super(options.message)
    this.name = 'NotionSyncError'
    this.code = options.code ?? 'sync_error'
    this.status = options.status ?? null
    this.retryable = options.retryable ?? true
    this.conflicts = options.conflicts ?? []
  }
}

export interface SerializedQueue {
  run: <T>(operation: () => Promise<T>) => Promise<T>
}

export function createSerializedQueue(): SerializedQueue {
  let tail = Promise.resolve()
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation, operation)
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}

interface BrowserSyncLifecycleConfig {
  isOnline?: () => boolean
  refreshOnWindowFocus?: boolean
  focusMode: 'window' | 'visible-document'
  pollIntervalMs: number
  invalidationPollIntervalMs: number
  onOnline: () => void
  onOffline?: () => void
  onFocus: () => void
  onInvalidationPoll: () => void
}

export interface BrowserSyncLifecycle {
  readonly signal: AbortSignal
  online: () => boolean
  start: () => void
  dispose: (reason: Error) => void
}

export function createBrowserSyncLifecycle(
  config: BrowserSyncLifecycleConfig,
): BrowserSyncLifecycle {
  const controller = new AbortController()
  let started = false
  let pollInterval: ReturnType<typeof setInterval> | undefined
  let invalidationInterval: ReturnType<typeof setInterval> | undefined

  function online(): boolean {
    return (
      config.isOnline?.() ??
      (typeof navigator === 'undefined' || navigator.onLine !== false)
    )
  }

  function handleVisibility(): void {
    if (document.visibilityState === 'visible') config.onFocus()
  }

  function start(): void {
    if (started || typeof window === 'undefined') return
    started = true
    window.addEventListener('online', config.onOnline)
    if (config.onOffline) window.addEventListener('offline', config.onOffline)
    if (config.refreshOnWindowFocus !== false) {
      if (config.focusMode === 'window') {
        window.addEventListener('focus', config.onFocus)
      } else {
        document.addEventListener('visibilitychange', handleVisibility)
      }
    }
    if (config.pollIntervalMs > 0) {
      pollInterval = setInterval(config.onFocus, config.pollIntervalMs)
    }
    if (config.invalidationPollIntervalMs > 0) {
      invalidationInterval = setInterval(
        config.onInvalidationPoll,
        config.invalidationPollIntervalMs,
      )
    }
  }

  function dispose(reason: Error): void {
    if (controller.signal.aborted) return
    controller.abort(reason)
    if (pollInterval) clearInterval(pollInterval)
    if (invalidationInterval) clearInterval(invalidationInterval)
    if (started && typeof window !== 'undefined') {
      window.removeEventListener('online', config.onOnline)
      if (config.onOffline) window.removeEventListener('offline', config.onOffline)
      if (config.refreshOnWindowFocus !== false) {
        if (config.focusMode === 'window') {
          window.removeEventListener('focus', config.onFocus)
        } else {
          document.removeEventListener('visibilitychange', handleVisibility)
        }
      }
    }
    started = false
  }

  return { signal: controller.signal, online, start, dispose }
}

interface JsonRequesterConfig {
  fetch: typeof globalThis.fetch
  lifecycleSignal?: AbortSignal
  timeoutMs?: number
  timeoutMessage?: string
}

export type JsonRequester = <T>(url: string, init?: RequestInit) => Promise<T>

export function createJsonRequester(config: JsonRequesterConfig): JsonRequester {
  return async function requestJson<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    const signals = [config.lifecycleSignal, init.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined && signal !== null,
    )
    const abort = (event: Event): void => {
      const signal = event.target as AbortSignal
      controller.abort(signal.reason)
    }
    for (const signal of signals) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', abort, { once: true })
    }
    const timeout = config.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, config.timeoutMs)
      : undefined

    let response: Response
    try {
      response = await config.fetch(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (!timedOut) {
        const aborted = signals.find((signal) => signal.aborted)
        if (aborted?.reason) throw aborted.reason
      }
      let message = 'The network request failed.'
      if (timedOut) {
        message = config.timeoutMessage ?? 'The request timed out.'
      } else if (error instanceof Error) {
        message = error.message
      }
      throw new NotionSyncError({
        code: timedOut ? 'request_timeout' : 'network_error',
        message,
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      for (const signal of signals) signal.removeEventListener('abort', abort)
    }

    const body = (await response.json().catch(() => ({}))) as T | NotionErrorBody
    if (!response.ok) {
      const error = (body as NotionErrorBody).error
      throw new NotionSyncError({
        status: response.status,
        code: error?.code ?? `http_${response.status}`,
        message: error?.message ?? `The sync server returned HTTP ${response.status}.`,
        retryable: error?.retryable ?? response.status >= 500,
        ...(error?.conflicts ? { conflicts: error.conflicts } : {}),
      })
    }
    return body as T
  }
}
