import type { NotionPropertyConflict } from './protocol.js'

export interface NotionRateLimitOperation {
  /** Non-secret identifier shared by every handler using one Notion connection. */
  scope: string
  minimumIntervalMs: number
  signal?: AbortSignal
}

export interface NotionRateLimiter {
  schedule: <T>(
    operation: NotionRateLimitOperation,
    run: () => Promise<T>,
  ) => Promise<T>
}

export interface NotionServerEvent {
  type: 'notion_request'
  operation:
    | 'data_source.retrieve'
    | 'data_source.query'
    | 'page.create'
    | 'page.retrieve'
    | 'page.update'
    | 'page_property.retrieve'
    | 'page_content.retrieve'
    | 'page_content.update'
    | 'unknown'
  attempt: number
  outcome: 'success' | 'retry' | 'error'
  durationMs: number
  status: number | null
  retryInMs: number | null
}

interface NotionApiErrorResponse {
  code?: string
}

export class NotionHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs: number | null
  readonly conflicts: ReadonlyArray<NotionPropertyConflict>

  constructor(options: {
    status: number
    code: string
    message: string
    retryable: boolean
    retryAfterMs?: number | null
    conflicts?: ReadonlyArray<NotionPropertyConflict>
  }) {
    super(options.message)
    this.name = 'NotionHttpError'
    this.status = options.status
    this.code = options.code
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs ?? null
    this.conflicts = options.conflicts ?? []
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, milliseconds)
    const handleAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

/** Coordinates one or more handlers in the same JavaScript process. */
export function createMemoryNotionRateLimiter(): NotionRateLimiter {
  const queues = new Map<string, Promise<void>>()
  const nextRequestAt = new Map<string, number>()
  return {
    async schedule<T>(operation: NotionRateLimitOperation, run: () => Promise<T>) {
      const previous = queues.get(operation.scope) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const queued = previous.then(() => current)
      queues.set(operation.scope, queued)
      await previous
      try {
        const delay = Math.max(
          0,
          (nextRequestAt.get(operation.scope) ?? 0) - Date.now(),
        )
        if (delay > 0) await sleep(delay, operation.signal)
        nextRequestAt.set(
          operation.scope,
          Date.now() + operation.minimumIntervalMs,
        )
        return await run()
      } finally {
        release()
        if (queues.get(operation.scope) === queued) queues.delete(operation.scope)
      }
    },
  }
}

function requestOperation(
  path: string,
  method: string,
): NotionServerEvent['operation'] {
  if (/\/v1\/data_sources\/[^/]+\/query/.test(path)) {
    return 'data_source.query'
  }
  if (/\/v1\/data_sources\/[^/]+/.test(path)) {
    return 'data_source.retrieve'
  }
  if (/\/v1\/pages\/[^/]+\/properties\//.test(path)) {
    return 'page_property.retrieve'
  }
  if (/\/v1\/pages\/[^/]+\/markdown/.test(path)) {
    return method === 'PATCH' ? 'page_content.update' : 'page_content.retrieve'
  }
  if (path === '/v1/pages' && method === 'POST') return 'page.create'
  if (/\/v1\/pages\/[^/]+/.test(path)) {
    return method === 'PATCH' ? 'page.update' : 'page.retrieve'
  }
  return 'unknown'
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function canRetryNotionRequest(
  operation: NotionServerEvent['operation'],
  error: unknown,
): boolean {
  if (operation !== 'page.create') {
    return !(error instanceof NotionHttpError) || error.retryable
  }
  return error instanceof NotionHttpError && error.status === 429
}

function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get('Retry-After')
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : null
}

interface CreateNotionRequesterConfig {
  token: string
  notionVersion: string
  baseUrl: string
  fetch: typeof globalThis.fetch
  rateLimiter: NotionRateLimiter
  rateLimitScope: string
  minimumRequestIntervalMs: number
  requestTimeoutMs: number
  maxRetries: number
  onEvent?: (event: NotionServerEvent) => void
}

export type NotionRequester = <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>

export function createNotionRequester(
  config: CreateNotionRequesterConfig,
): NotionRequester {
  function emit(event: NotionServerEvent): void {
    try {
      config.onEvent?.(event)
    } catch {
      // Telemetry must never affect synchronization.
    }
  }

  function schedule<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return config.rateLimiter.schedule(
      {
        scope: config.rateLimitScope,
        minimumIntervalMs: config.minimumRequestIntervalMs,
        ...(signal ? { signal } : {}),
      },
      operation,
    )
  }

  return async function requestNotion<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = Date.now()
      const method = init.method ?? 'GET'
      const operation = requestOperation(path, method)
      try {
        const result = await schedule(async () => {
          const headers = new Headers(init.headers)
          headers.set('Authorization', `Bearer ${config.token}`)
          headers.set('Notion-Version', config.notionVersion)
          headers.set('Accept', 'application/json')
          if (init.body) headers.set('Content-Type', 'application/json')

          const controller = new AbortController()
          let timedOut = false
          const requestSignal = init.signal
          const handleAbort = () => controller.abort(requestSignal?.reason)
          if (requestSignal?.aborted) handleAbort()
          else requestSignal?.addEventListener('abort', handleAbort, { once: true })
          const timeout = setTimeout(() => {
            timedOut = true
            controller.abort(new Error('Notion request timed out.'))
          }, config.requestTimeoutMs)

          let response: Response
          try {
            response = await config.fetch(`${config.baseUrl}${path}`, {
              ...init,
              headers,
              signal: controller.signal,
            })
          } catch (error) {
            if (timedOut) {
              throw new NotionHttpError({
                status: 504,
                code: 'notion_request_timeout',
                message: 'Notion did not respond before the request timeout.',
                retryable: true,
              })
            }
            if (init.signal?.aborted) {
              throw new NotionHttpError({
                status: 408,
                code: 'request_cancelled',
                message: 'The sync request was cancelled.',
                retryable: false,
              })
            }
            throw error
          } finally {
            clearTimeout(timeout)
            requestSignal?.removeEventListener('abort', handleAbort)
          }

          const body = (await response.json().catch(() => ({}))) as
            | T
            | NotionApiErrorResponse
          if (!response.ok) {
            const error = body as NotionApiErrorResponse
            throw new NotionHttpError({
              status: response.status,
              code: error.code ?? `http_${response.status}`,
              message: `Notion rejected the request (${error.code ?? `HTTP ${response.status}`}).`,
              retryable: retryableStatus(response.status),
              retryAfterMs: parseRetryAfter(response),
            })
          }
          return { body: body as T, status: response.status }
        }, init.signal ?? undefined)
        emit({
          type: 'notion_request',
          operation,
          attempt: attempt + 1,
          outcome: 'success',
          durationMs: Date.now() - startedAt,
          status: result.status,
          retryInMs: null,
        })
        return result.body
      } catch (error) {
        const canRetry =
          attempt < config.maxRetries &&
          !init.signal?.aborted &&
          canRetryNotionRequest(operation, error)
        if (!canRetry) {
          emit({
            type: 'notion_request',
            operation,
            attempt: attempt + 1,
            outcome: 'error',
            durationMs: Date.now() - startedAt,
            status: error instanceof NotionHttpError ? error.status : null,
            retryInMs: null,
          })
          throw error
        }

        const retryAfter =
          error instanceof NotionHttpError ? error.retryAfterMs : null
        const exponential = Math.min(8_000, 300 * 2 ** attempt)
        const backoff = retryAfter ?? exponential * (0.5 + Math.random())
        emit({
          type: 'notion_request',
          operation,
          attempt: attempt + 1,
          outcome: 'retry',
          durationMs: Date.now() - startedAt,
          status: error instanceof NotionHttpError ? error.status : null,
          retryInMs: backoff,
        })
        await sleep(backoff, init.signal ?? undefined)
      }
    }
  }
}
