import { NotionSchemaError } from './schema.js'
import type {
  InferNotionOutput,
  NotionFields,
  NotionPageLike,
  NotionSchema,
} from './schema.js'
import type {
  NotionErrorBody,
  NotionListResult,
  NotionMutation,
  NotionMutationBatch,
  NotionMutationResult,
  NotionPageContent,
  NotionPageContentMutation,
  NotionPropertyConflict,
  NotionSchemaMismatch,
  NotionSchemaResult,
} from './protocol.js'

export const LATEST_NOTION_VERSION = '2026-03-11'

export type NotionSyncAuthorizationResult = boolean | Response

export type NotionSyncAuthorizer = (
  request: Request,
) =>
  | NotionSyncAuthorizationResult
  | Promise<NotionSyncAuthorizationResult>

export type NotionFilterOperator =
  | 'equals'
  | 'does_not_equal'
  | 'contains'
  | 'does_not_contain'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal_to'
  | 'less_than_or_equal_to'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'

type NotionFilterScalar<T> = NonNullable<T> extends ReadonlyArray<infer TItem>
  ? TItem extends string
    ? TItem
    : TItem extends { id: string }
      ? string
      : string
  : NonNullable<T> extends { start: string }
    ? string
    : NonNullable<T>

export type NotionFilterRule<TFields extends NotionFields> = {
  [TKey in keyof TFields & string]:
    | {
        field: TKey
        operator: NotionFilterOperator
        value: NotionFilterScalar<InferNotionOutput<TFields>[TKey]>
      }
    | {
        field: TKey
        operator: 'is_empty' | 'is_not_empty'
      }
}[keyof TFields & string]

export type NotionFilter<TFields extends NotionFields> =
  | NotionFilterRule<TFields>
  | { and: ReadonlyArray<NotionFilter<TFields>> }
  | { or: ReadonlyArray<NotionFilter<TFields>> }

interface NotionSyncHandlerBaseConfig<TFields extends NotionFields> {
  token: string
  dataSourceId: string
  schema: NotionSchema<TFields>
  notionVersion?: string
  /** Override for tests, edge runtimes, or a custom Notion proxy. */
  fetch?: typeof globalThis.fetch
  /** @default https://api.notion.com */
  baseUrl?: string
  /** Validate property names and types before the first data operation. */
  validateSchema?: boolean
  /** Revalidate a previously valid schema after this interval. @default 60000 */
  schemaValidationTtlMs?: number
  /** Space requests to stay below Notion's average three requests/second limit. */
  minimumRequestIntervalMs?: number
  /** Shared request scheduler for multi-handler or multi-instance deployments. */
  rateLimiter?: NotionRateLimiter
  /** Stable non-secret key identifying the Notion connection to rateLimiter. */
  rateLimitScope?: string
  /** Structured telemetry that never includes tokens, request bodies, or content. */
  onEvent?: (event: NotionServerEvent) => void
  /** Shared version store bumped by a verified Notion webhook. */
  invalidationStore?: NotionInvalidationStore
  /** Stable non-secret key shared with the webhook handler. */
  invalidationScope?: string
  /** Abort each individual Notion request after this interval. @default 30000 */
  requestTimeoutMs?: number
  /** Maximum accepted mutation request body size in bytes. @default 262144 */
  maxRequestBodyBytes?: number
  /** Enable lazy read/write routes for page contents in this data source. */
  pageContent?: boolean
  /** Notion sort descriptors applied to every paginated list request. */
  sorts?: ReadonlyArray<
    | {
        field: keyof TFields & string
        property?: never
        direction: 'ascending' | 'descending'
      }
    | {
        /** @deprecated Prefer field so generated stable property IDs are used. */
        property: string
        field?: never
        direction: 'ascending' | 'descending'
      }
  >
  /** Fixed server-side filter compiled from local field keys to stable IDs. */
  filter?: NotionFilter<TFields>
  /**
   * Fields whose paginated page-property values must be read completely.
   * Each selected field adds Notion requests per returned page, so opt in only
   * when values may exceed the 25-reference page response limit.
   */
  completeProperties?: ReadonlyArray<keyof TFields & string>
  maxRetries?: number
}

export interface NotionIdempotencyOperation {
  /** Namespaces keys by data source and operation family. */
  scope: string
  /** Client-generated retry key. */
  key: string
  /** Stable request fingerprint; reuse with another payload must fail. */
  fingerprint: string
}

export interface NotionIdempotencyStore {
  /**
   * Execute once and durably replay the result for the same key/fingerprint.
   * Implementations must serialize concurrent callers across server instances,
   * persist successful JSON-compatible results, and never cache failures.
   */
  execute: <T>(
    operation: NotionIdempotencyOperation,
    run: () => Promise<T>,
  ) => Promise<T>
}

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

export interface NotionInvalidationStore {
  getVersion: (scope: string) => Promise<number>
  /** Must deduplicate repeated event IDs before incrementing the version. */
  invalidate: (scope: string, eventId: string) => Promise<number>
}

export function createMemoryNotionInvalidationStore(): NotionInvalidationStore {
  const versions = new Map<string, number>()
  const events = new Map<string, Set<string>>()
  return {
    async getVersion(scope) {
      return versions.get(scope) ?? 0
    },
    async invalidate(scope, eventId) {
      const seen = events.get(scope) ?? new Set<string>()
      events.set(scope, seen)
      if (seen.has(eventId)) return versions.get(scope) ?? 0
      seen.add(eventId)
      const version = (versions.get(scope) ?? 0) + 1
      versions.set(scope, version)
      return version
    },
  }
}

export interface NotionWebhookHandlerConfig {
  dataSourceId: string
  invalidationStore: NotionInvalidationStore
  invalidationScope?: string
  /** Token delivered once when the webhook subscription is created. */
  verificationToken?: string
  /** Setup-only callback used to retain the one-time verification token. */
  onVerificationToken?: (token: string) => void | Promise<void>
  maxRequestBodyBytes?: number
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

export class NotionIdempotencyConflictError extends Error {
  constructor() {
    super('An idempotency key was reused with a different request payload.')
    this.name = 'NotionIdempotencyConflictError'
  }
}

export function createMemoryNotionIdempotencyStore(): NotionIdempotencyStore {
  const completed = new Map<string, { fingerprint: string; value: unknown }>()
  const inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<unknown> }
  >()

  return {
    async execute<T>(operation: NotionIdempotencyOperation, run: () => Promise<T>) {
      const ledgerKey = `${operation.scope}:${operation.key}`
      const existing = completed.get(ledgerKey)
      if (existing) {
        if (existing.fingerprint !== operation.fingerprint) {
          throw new NotionIdempotencyConflictError()
        }
        return structuredClone(existing.value) as T
      }
      const pending = inFlight.get(ledgerKey)
      if (pending) {
        if (pending.fingerprint !== operation.fingerprint) {
          throw new NotionIdempotencyConflictError()
        }
        return structuredClone(await pending.promise) as T
      }

      const promise = run().then((value) => {
        const retained = structuredClone(value)
        completed.set(ledgerKey, {
          fingerprint: operation.fingerprint,
          value: retained,
        })
        return retained
      })
      inFlight.set(ledgerKey, {
        fingerprint: operation.fingerprint,
        promise,
      })
      try {
        return structuredClone(await promise) as T
      } finally {
        if (inFlight.get(ledgerKey)?.promise === promise) inFlight.delete(ledgerKey)
      }
    },
  }
}

type NotionSyncAuthorizationPolicy =
      | {
          /** Authenticate and authorize every GET and POST request. */
          authorize: NotionSyncAuthorizer
          dangerouslyAllowUnauthenticated?: never
        }
      | {
          authorize?: never
          /** Explicit opt-out for local prototypes that have no authentication. */
          dangerouslyAllowUnauthenticated: true
        }

type NotionSyncIdempotencyPolicy =
  | {
      /** Serve a collection without exposing any mutation route. */
      readOnly: true
      idempotencyStore?: never
      dangerouslyAllowEphemeralIdempotency?: never
    }
  | {
      readOnly?: false
      /**
       * Durable, shared execution ledger. The implementation must survive
       * process restarts and coordinate every server instance.
       */
      idempotencyStore: NotionIdempotencyStore
      dangerouslyAllowEphemeralIdempotency?: never
    }
  | {
      readOnly?: false
      idempotencyStore?: never
      /** Explicit local-development escape hatch; never use in production. */
      dangerouslyAllowEphemeralIdempotency: true
    }

export type NotionSyncHandlerConfig<TFields extends NotionFields> =
  NotionSyncHandlerBaseConfig<TFields> &
    NotionSyncAuthorizationPolicy &
    NotionSyncIdempotencyPolicy

export interface ResolveNotionDataSourceIdConfig {
  token: string
  /** A data source ID, or a database ID when the database has one data source. */
  id: string
  notionVersion?: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

interface NotionListResponse {
  results?: Array<unknown>
  has_more?: boolean
  next_cursor?: string | null
}

interface NotionPropertyItemListResponse {
  object?: unknown
  results?: Array<unknown>
  has_more?: unknown
  next_cursor?: unknown
}

interface NotionDataSourceResponse {
  properties?: Record<string, unknown>
}

interface NotionMarkdownResponse {
  object?: unknown
  id?: unknown
  markdown?: unknown
  truncated?: unknown
  unknown_block_ids?: unknown
}

interface NotionApiErrorResponse {
  code?: string
  message?: string
}

class NotionHttpError extends Error {
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

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}

async function fingerprint(value: unknown): Promise<string> {
  const serialized = stableJson(value)
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 support is required for idempotency.')
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(serialized),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { ...init, headers })
}

function isPage(value: unknown): value is NotionPageLike {
  if (!value || typeof value !== 'object') return false
  const page = value as Partial<NotionPageLike>
  return (
    typeof page.id === 'string' &&
    typeof page.created_time === 'string' &&
    typeof page.last_edited_time === 'string' &&
    typeof page.url === 'string' &&
    !!page.properties &&
    typeof page.properties === 'object'
  )
}

function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get('Retry-After')
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : null
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
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

function isMutationBatch<TItem extends object>(
  value: unknown,
): value is NotionMutationBatch<TItem> {
  if (!value || typeof value !== 'object') return false
  const batch = value as Partial<NotionMutationBatch<TItem>>
  return (
    typeof batch.idempotencyKey === 'string' &&
    batch.idempotencyKey.length > 0 &&
    Array.isArray(batch.mutations)
  )
}

function isPageContentMutation(value: unknown): value is NotionPageContentMutation {
  if (!value || typeof value !== 'object') return false
  const mutation = value as Partial<NotionPageContentMutation>
  return (
    mutation.type === 'page_content' &&
    typeof mutation.idempotencyKey === 'string' &&
    mutation.idempotencyKey.length > 0 &&
    typeof mutation.pageId === 'string' &&
    mutation.pageId.length > 0 &&
    typeof mutation.baseMarkdown === 'string' &&
    typeof mutation.markdown === 'string'
  )
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new NotionHttpError({
      status: 413,
      code: 'request_too_large',
      message: `The request body exceeds the ${maxBytes}-byte limit.`,
      retryable: false,
    })
  }

  if (!request.body) {
    throw new NotionHttpError({
      status: 400,
      code: 'invalid_json',
      message: 'Expected a JSON request body.',
      retryable: false,
    })
  }

  const reader = request.body.getReader()
  const chunks: Array<Uint8Array> = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new NotionHttpError({
          status: 413,
          code: 'request_too_large',
          message: `The request body exceeds the ${maxBytes}-byte limit.`,
          retryable: false,
        })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new NotionHttpError({
      status: 400,
      code: 'invalid_json',
      message: 'The request body is not valid JSON.',
      retryable: false,
    })
  }
}

async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new NotionHttpError({
      status: 413,
      code: 'request_too_large',
      message: `The request body exceeds the ${maxBytes}-byte limit.`,
      retryable: false,
    })
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new NotionHttpError({
      status: 413,
      code: 'request_too_large',
      message: `The request body exceeds the ${maxBytes}-byte limit.`,
      retryable: false,
    })
  }
  return body
}

async function notionWebhookSignature(
  verificationToken: string,
  body: string,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto HMAC-SHA256 support is required for webhooks.')
  }
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verificationToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

function signaturesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function eventReferencesDataSource(
  value: unknown,
  dataSourceId: string,
  depth = 0,
): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) =>
      eventReferencesDataSource(item, dataSourceId, depth + 1),
    )
  }
  const record = value as Record<string, unknown>
  if (record.data_source_id === dataSourceId) return true
  if (record.type === 'data_source' && record.id === dataSourceId) return true
  return Object.values(record).some((item) =>
    eventReferencesDataSource(item, dataSourceId, depth + 1),
  )
}

/** Verifies Notion events and converts matching changes into a version bump. */
export function createNotionWebhookHandler(
  config: NotionWebhookHandlerConfig,
): (request: Request) => Promise<Response> {
  if (!config.dataSourceId) throw new Error('A Notion data source ID is required.')
  const scope = config.invalidationScope ?? config.dataSourceId
  const maxBytes = Math.max(1, config.maxRequestBodyBytes ?? 64 * 1024)
  return async (request) => {
    try {
      if (request.method !== 'POST') {
        return json(
          {
            error: {
              code: 'method_not_allowed',
              message: 'Only POST is supported.',
              retryable: false,
            },
          } satisfies NotionErrorBody,
          { status: 405, headers: { Allow: 'POST' } },
        )
      }
      const rawBody = await readTextBody(request, maxBytes)
      let body: unknown
      try {
        body = JSON.parse(rawBody) as unknown
      } catch {
        throw new NotionHttpError({
          status: 400,
          code: 'invalid_json',
          message: 'The webhook body is not valid JSON.',
          retryable: false,
        })
      }
      if (!isRecord(body)) {
        throw new NotionHttpError({
          status: 400,
          code: 'invalid_webhook',
          message: 'The webhook body is malformed.',
          retryable: false,
        })
      }
      if (typeof body.verification_token === 'string') {
        await config.onVerificationToken?.(body.verification_token)
        return json({ ok: true })
      }
      if (!config.verificationToken) {
        throw new NotionHttpError({
          status: 503,
          code: 'webhook_verification_token_missing',
          message: 'The webhook verification token is not configured.',
          retryable: false,
        })
      }
      const received = request.headers.get('X-Notion-Signature') ?? ''
      const expected = await notionWebhookSignature(
        config.verificationToken,
        rawBody,
      )
      if (!signaturesEqual(received, expected)) {
        throw new NotionHttpError({
          status: 401,
          code: 'invalid_webhook_signature',
          message: 'The webhook signature is invalid.',
          retryable: false,
        })
      }
      if (typeof body.id !== 'string' || typeof body.type !== 'string') {
        throw new NotionHttpError({
          status: 400,
          code: 'invalid_webhook',
          message: 'The webhook event is missing its ID or type.',
          retryable: false,
        })
      }
      if (eventReferencesDataSource(body, config.dataSourceId)) {
        await config.invalidationStore.invalidate(scope, body.id)
      }
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      const notionError = error instanceof NotionHttpError ? error : null
      return json(
        {
          error: {
            code: notionError?.code ?? 'internal_error',
            message:
              notionError?.message ??
              'The webhook handler encountered an unexpected error.',
            retryable: notionError?.retryable ?? true,
          },
        } satisfies NotionErrorBody,
        { status: notionError?.status ?? 500 },
      )
    }
  }
}

function actualPropertyType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const type = (value as Record<string, unknown>).type
  return typeof type === 'string' ? type : null
}

function dataSourceProperty(
  properties: Record<string, unknown>,
  name: string,
  propertyId?: string,
): unknown {
  if (propertyId) {
    for (const property of Object.values(properties)) {
      if (!property || typeof property !== 'object') continue
      const id = (property as Record<string, unknown>).id
      if (typeof id !== 'string') continue
      try {
        if (
          id === propertyId ||
          decodeURIComponent(id) === decodeURIComponent(propertyId)
        ) {
          return property
        }
      } catch {
        if (id === propertyId) return property
      }
    }
  }
  return properties[name]
}

/**
 * Accepts either a data source ID or a single-source database ID and returns
 * the concrete data source ID required by Notion's data APIs.
 */
export async function resolveNotionDataSourceId(
  config: ResolveNotionDataSourceIdConfig,
): Promise<string> {
  const fetcher = config.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('A fetch implementation is required.')

  const baseUrl = (config.baseUrl ?? 'https://api.notion.com').replace(/\/$/, '')
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Notion-Version': config.notionVersion ?? LATEST_NOTION_VERSION,
    Accept: 'application/json',
  }
  const encodedId = encodeURIComponent(config.id)
  const dataSourceResponse = await fetcher(
    `${baseUrl}/v1/data_sources/${encodedId}`,
    { headers },
  )
  if (dataSourceResponse.ok) return config.id

  const dataSourceError = (await dataSourceResponse.json().catch(() => ({}))) as
    NotionApiErrorResponse
  if (dataSourceResponse.status !== 404) {
    throw new Error(
      dataSourceError.message ??
        `Notion could not retrieve the configured data source (HTTP ${dataSourceResponse.status}).`,
    )
  }

  const databaseResponse = await fetcher(`${baseUrl}/v1/databases/${encodedId}`, {
    headers,
  })
  const database = (await databaseResponse.json().catch(() => ({}))) as {
    data_sources?: Array<{ id?: unknown; name?: unknown }>
    message?: string
  }
  if (!databaseResponse.ok) {
    throw new Error(
      database.message ??
        'The configured ID is neither an accessible data source nor database.',
    )
  }

  const dataSources = (database.data_sources ?? []).filter(
    (source): source is { id: string; name?: unknown } =>
      typeof source.id === 'string',
  )
  if (dataSources.length === 0) {
    throw new Error('The configured Notion database has no accessible data sources.')
  }
  if (dataSources.length > 1) {
    const choices = dataSources
      .map((source) => {
        const name =
          typeof source.name === 'string' && source.name.trim()
            ? source.name.trim()
            : 'Unnamed data source'
        return `${name} (${source.id})`
      })
      .join(', ')
    throw new Error(
      `The configured Notion database has multiple data sources: ${choices}. Set NOTION_DATA_SOURCE_ID or pass --id with the exact source you want to sync.`,
    )
  }
  return dataSources[0]!.id
}

/**
 * Creates a framework-neutral Request -> Response handler. Keep this handler on
 * the server: it is the only layer that receives the Notion token.
 */
export function createNotionSyncHandler<const TFields extends NotionFields>(
  config: NotionSyncHandlerConfig<TFields>,
): (request: Request) => Promise<Response> {
  type TItem = InferNotionOutput<TFields>

  if (!config.token) throw new Error('A Notion token is required.')
  if (!config.dataSourceId) throw new Error('A Notion data source ID is required.')
  if (!config.authorize && config.dangerouslyAllowUnauthenticated !== true) {
    throw new Error(
      'An authorize callback is required. For a local-only prototype, set dangerouslyAllowUnauthenticated: true explicitly.',
    )
  }
  if (
    config.readOnly !== true &&
    !config.idempotencyStore &&
    config.dangerouslyAllowEphemeralIdempotency !== true
  ) {
    throw new Error(
      'A durable idempotencyStore is required. For a local-only single-process prototype, set dangerouslyAllowEphemeralIdempotency: true explicitly.',
    )
  }

  const fetcher = config.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('A fetch implementation is required.')
  const idempotencyStore =
    config.idempotencyStore ??
    (config.dangerouslyAllowEphemeralIdempotency === true
      ? createMemoryNotionIdempotencyStore()
      : null)

  const baseUrl = (config.baseUrl ?? 'https://api.notion.com').replace(/\/$/, '')
  const version = config.notionVersion ?? LATEST_NOTION_VERSION
  const minimumRequestIntervalMs = Math.max(
    0,
    config.minimumRequestIntervalMs ?? 350,
  )
  const requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 30_000)
  const maxRequestBodyBytes = Math.max(
    1,
    config.maxRequestBodyBytes ?? 256 * 1024,
  )
  const schemaValidationTtlMs = Math.max(
    0,
    config.schemaValidationTtlMs ?? 60_000,
  )
  const maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 4))
  const idDescriptor = config.schema.fields[config.schema.idField]!
  const idPropertyName = idDescriptor.name ?? null
  const idPropertyReference = idDescriptor.propertyId ?? idPropertyName
  const rateLimiter = config.rateLimiter ?? createMemoryNotionRateLimiter()
  if (config.rateLimiter && !config.rateLimitScope) {
    throw new Error(
      'rateLimitScope is required when a shared rateLimiter is configured.',
    )
  }
  const rateLimitScope = config.rateLimitScope ?? config.dataSourceId
  const invalidationScope = config.invalidationScope ?? config.dataSourceId
  let schemaValidation:
    | { checkedAt: number; result: NotionSchemaResult }
    | null = null

  const completeProperties = (config.completeProperties ?? []).map((field) => {
    const descriptor = config.schema.fields[field]
    if (
      !descriptor ||
      !descriptor.name ||
      !['title', 'rich_text', 'people', 'relation'].includes(descriptor.kind)
    ) {
      throw new Error(
        `completeProperties contains ${field}, which is not a paginated title, rich text, people, or relation field.`,
      )
    }
    return { field, descriptor }
  })

  const compileFilter = (
    filter: NotionFilter<TFields>,
  ): Record<string, unknown> => {
    if ('and' in filter) {
      const children = filter.and
      if (children.length === 0) {
        throw new Error('A Notion and filter cannot be empty.')
      }
      return { and: children.map(compileFilter) }
    }
    if ('or' in filter) {
      const children = filter.or
      if (children.length === 0) {
        throw new Error('A Notion or filter cannot be empty.')
      }
      return { or: children.map(compileFilter) }
    }

    const descriptor = config.schema.fields[filter.field]
    if (!descriptor?.name || ['page_id', 'page_url'].includes(descriptor.kind)) {
      throw new Error(
        `The filter field ${filter.field} is not a Notion data-source property.`,
      )
    }
    const conditionType = descriptor.kind === 'id' ? 'rich_text' : descriptor.kind
    const allowed = new Set<string>(
      conditionType === 'checkbox'
        ? ['equals', 'does_not_equal']
        : conditionType === 'number'
          ? [
              'equals',
              'does_not_equal',
              'greater_than',
              'less_than',
              'greater_than_or_equal_to',
              'less_than_or_equal_to',
              'is_empty',
              'is_not_empty',
            ]
          : conditionType === 'date'
            ? [
                'equals',
                'before',
                'after',
                'on_or_before',
                'on_or_after',
                'is_empty',
                'is_not_empty',
              ]
            : ['select', 'status'].includes(conditionType)
              ? ['equals', 'does_not_equal', 'is_empty', 'is_not_empty']
              : ['multi_select', 'people', 'relation'].includes(conditionType)
                ? ['contains', 'does_not_contain', 'is_empty', 'is_not_empty']
                : ['title', 'rich_text', 'url', 'email', 'phone_number'].includes(
                      conditionType,
                    )
                  ? [
                      'equals',
                      'does_not_equal',
                      'contains',
                      'does_not_contain',
                      'starts_with',
                      'ends_with',
                      'is_empty',
                      'is_not_empty',
                    ]
                  : [],
    )
    if (!allowed.has(filter.operator)) {
      throw new Error(
        `The ${filter.operator} operator is not supported for ${filter.field} (${conditionType}).`,
      )
    }
    const value = 'value' in filter ? filter.value : true
    return {
      property: descriptor.propertyId ?? descriptor.name,
      [conditionType]: { [filter.operator]: value },
    }
  }
  const fixedFilter = config.filter ? compileFilter(config.filter) : null
  const fixedSorts = (config.sorts ?? []).map((sort) => {
    if ('field' in sort && sort.field !== undefined) {
      const descriptor = config.schema.fields[sort.field]
      if (!descriptor?.name || ['page_id', 'page_url'].includes(descriptor.kind)) {
        throw new Error(
          `The sort field ${sort.field} is not a Notion data-source property.`,
        )
      }
      return {
        property: descriptor.propertyId ?? descriptor.name,
        direction: sort.direction,
      }
    }
    return { property: sort.property, direction: sort.direction }
  })

  const schedule = <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> =>
    rateLimiter.schedule(
      {
        scope: rateLimitScope,
        minimumIntervalMs: minimumRequestIntervalMs,
        ...(signal ? { signal } : {}),
      },
      operation,
    )

  const emit = (event: NotionServerEvent) => {
    try {
      config.onEvent?.(event)
    } catch {
      // Telemetry must never affect synchronization.
    }
  }

  const requestOperation = (
    path: string,
    method: string,
  ): NotionServerEvent['operation'] => {
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
      return method === 'PATCH'
        ? 'page_content.update'
        : 'page_content.retrieve'
    }
    if (path === '/v1/pages' && method === 'POST') return 'page.create'
    if (/\/v1\/pages\/[^/]+/.test(path)) {
      return method === 'PATCH' ? 'page.update' : 'page.retrieve'
    }
    return 'unknown'
  }

  const requestNotion = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const startedAt = Date.now()
      const method = init.method ?? 'GET'
      const operation = requestOperation(path, method)
      try {
        const result = await schedule(async () => {
          const headers = new Headers(init.headers)
          headers.set('Authorization', `Bearer ${config.token}`)
          headers.set('Notion-Version', version)
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
          }, requestTimeoutMs)

          let response: Response
          try {
            response = await fetcher(`${baseUrl}${path}`, {
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
          attempt < maxRetries &&
          !init.signal?.aborted &&
          (!(error instanceof NotionHttpError) || error.retryable)
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

  const validateDataSource = async (
    signal?: AbortSignal,
  ): Promise<NotionSchemaResult> => {
    const dataSource = await requestNotion<NotionDataSourceResponse>(
      `/v1/data_sources/${encodeURIComponent(config.dataSourceId)}`,
      signal ? { signal } : {},
    )
    const properties = dataSource.properties ?? {}
    const mismatches: Array<NotionSchemaMismatch> = []

    for (const expected of config.schema.expectedProperties()) {
      const actual = actualPropertyType(
        dataSourceProperty(
          properties,
          expected.name,
          expected.propertyId,
        ),
      )
      if (actual !== expected.type) {
        mismatches.push({
          field: expected.field,
          name: expected.name,
          expected: expected.type,
          actual,
        })
      }
    }

    return {
      ok: mismatches.length === 0,
      dataSourceId: config.dataSourceId,
      mismatches,
    }
  }

  const ensureSchema = async (signal?: AbortSignal): Promise<void> => {
    if (config.validateSchema === false) return
    const now = Date.now()
    let result: NotionSchemaResult
    if (
      schemaValidation &&
      now - schemaValidation.checkedAt < schemaValidationTtlMs
    ) {
      result = schemaValidation.result
    } else {
      result = await validateDataSource(signal)
      schemaValidation = { checkedAt: Date.now(), result }
    }
    if (!result.ok) {
      const summary = result.mismatches
        .map(
          (mismatch) =>
            `${mismatch.name}: expected ${mismatch.expected}, received ${mismatch.actual ?? 'missing'}`,
        )
        .join('; ')
      throw new NotionHttpError({
        status: 422,
        code: 'schema_mismatch',
        message: `The Notion data source does not match the adapter schema. ${summary}`,
        retryable: false,
      })
    }
  }

  const queryPath = (): string => {
    const params = new URLSearchParams()
    for (const property of config.schema.expectedProperties()) {
      params.append(
        'filter_properties[]',
        property.propertyId ?? property.name,
      )
    }
    const query = params.toString()
    return `/v1/data_sources/${encodeURIComponent(config.dataSourceId)}/query${query ? `?${query}` : ''}`
  }

  const queryPages = async (
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<NotionListResponse> =>
    requestNotion<NotionListResponse>(queryPath(), {
      method: 'POST',
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })

  const completePageProperty = async (
    page: NotionPageLike,
    descriptor: (typeof completeProperties)[number]['descriptor'],
    signal?: AbortSignal,
  ): Promise<void> => {
    const property = dataSourceProperty(
      page.properties,
      descriptor.name!,
      descriptor.propertyId,
    )
    const propertyRecord = isRecord(property) ? property : null
    const propertyId =
      descriptor.propertyId ??
      (typeof propertyRecord?.id === 'string' ? propertyRecord.id : null)
    if (!propertyId) {
      throw new NotionHttpError({
        status: 422,
        code: 'property_id_missing',
        message: `The complete property ${descriptor.name} has no stable Notion property ID. Pull or push the schema before syncing it.`,
        retryable: false,
      })
    }

    const values: Array<unknown> = []
    let cursor: string | null = null
    const seen = new Set<string>()
    do {
      const params = new URLSearchParams({ page_size: '100' })
      if (cursor) params.set('start_cursor', cursor)
      const response = await requestNotion<NotionPropertyItemListResponse>(
        `/v1/pages/${encodeURIComponent(page.id)}/properties/${encodeURIComponent(propertyId)}?${params}`,
        signal ? { signal } : {},
      )
      if (response.object !== 'list' || !Array.isArray(response.results)) {
        throw new NotionHttpError({
          status: 502,
          code: 'invalid_notion_response',
          message: `Notion returned an invalid paginated value for ${descriptor.name}.`,
          retryable: true,
        })
      }
      for (const item of response.results) {
        const record = isRecord(item) ? item : null
        if (record && record.type === descriptor.kind) {
          values.push(record[descriptor.kind])
        }
      }
      cursor =
        response.has_more === true && typeof response.next_cursor === 'string'
          ? response.next_cursor
          : null
      if (cursor) {
        if (seen.has(cursor)) {
          throw new NotionHttpError({
            status: 502,
            code: 'repeated_property_cursor',
            message: `Notion repeated a pagination cursor for ${descriptor.name}.`,
            retryable: true,
          })
        }
        seen.add(cursor)
      }
    } while (cursor)

    const propertyKey = Object.entries(page.properties).find(([, value]) => {
      const record = isRecord(value) ? value : null
      if (descriptor.propertyId && typeof record?.id === 'string') {
        try {
          return (
            decodeURIComponent(record.id) ===
            decodeURIComponent(descriptor.propertyId)
          )
        } catch {
          return record.id === descriptor.propertyId
        }
      }
      return false
    })?.[0] ?? descriptor.name!
    page.properties[propertyKey] = {
      ...(propertyRecord ?? {}),
      id: propertyId,
      type: descriptor.kind,
      [descriptor.kind]: values,
      ...(descriptor.kind === 'relation' ? { has_more: false } : {}),
    }
  }

  const list = async (
    cursor: string | null,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<NotionListResult<TItem>> => {
    await ensureSchema(signal)
    const versionBefore = config.invalidationStore
      ? await config.invalidationStore.getVersion(invalidationScope)
      : null
    const body: Record<string, unknown> = { page_size: pageSize }
    if (cursor) body.start_cursor = cursor
    if (fixedFilter) body.filter = structuredClone(fixedFilter)
    if (fixedSorts.length) {
      body.sorts = structuredClone(fixedSorts)
    }
    const response = await queryPages(body, signal)
    const pages = (response.results ?? []).filter(
      (page): page is NotionPageLike => isPage(page) && page.in_trash !== true,
    )
    const rows: Array<TItem> = []
    for (const sourcePage of pages) {
      const page = structuredClone(sourcePage)
      for (const { descriptor } of completeProperties) {
        await completePageProperty(page, descriptor, signal)
      }
      rows.push(config.schema.parsePage(page))
    }
    const versionAfter = config.invalidationStore
      ? await config.invalidationStore.getVersion(invalidationScope)
      : null
    if (versionBefore !== versionAfter) {
      throw new NotionHttpError({
        status: 409,
        code: 'collection_changed_during_query',
        message: 'The Notion collection changed while it was being read.',
        retryable: true,
      })
    }

    return {
      rows,
      hasMore: response.has_more === true,
      nextCursor:
        typeof response.next_cursor === 'string' ? response.next_cursor : null,
      ...(versionAfter !== null ? { version: versionAfter } : {}),
    }
  }

  const findPageByKey = async (
    key: string,
    signal?: AbortSignal,
  ): Promise<NotionPageLike | null> => {
    if (!idPropertyName || !idPropertyReference) {
      throw new NotionHttpError({
        status: 405,
        code: 'read_only_key',
        message: 'A Notion page-ID key cannot be used for inserts.',
        retryable: false,
      })
    }
    const keyFilter = {
      property: idPropertyReference,
      rich_text: { equals: key },
    }
    const response = await queryPages({
      page_size: 2,
      filter: fixedFilter
        ? {
            and: [keyFilter, structuredClone(fixedFilter)],
          }
        : keyFilter,
    }, signal)
    const pages = (response.results ?? []).filter(isPage)
    if (pages.length > 1) {
      throw new NotionHttpError({
        status: 409,
        code: 'duplicate_client_id',
        message: `More than one Notion page has the same ${idPropertyName} value.`,
        retryable: false,
      })
    }
    return pages[0] ?? null
  }

  const resolvePage = async (
    mutation: NotionMutation<TItem>,
    signal?: AbortSignal,
  ): Promise<NotionPageLike | null> => {
    const pageId = config.schema.getPageId(mutation.value)
    if (pageId) {
      const page = await requestNotion<unknown>(
        `/v1/pages/${encodeURIComponent(pageId)}`,
        signal ? { signal } : {},
      )
      return isPage(page) ? page : null
    }
    return findPageByKey(mutation.key, signal)
  }

  const updatePage = async (
    pageId: string,
    value: TItem,
    signal?: AbortSignal,
    selectedFields?: ReadonlySet<keyof TFields & string>,
  ): Promise<TItem> => {
    const updated = await requestNotion<unknown>(
      `/v1/pages/${encodeURIComponent(pageId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          properties: config.schema.serialize(value, selectedFields),
        }),
        ...(signal ? { signal } : {}),
      },
    )
    if (!isPage(updated)) {
      throw new NotionHttpError({
        status: 502,
        code: 'invalid_notion_response',
        message: 'Notion returned an invalid page response.',
        retryable: true,
      })
    }
    return config.schema.parsePage(updated)
  }

  const applyMutation = async (
    mutation: NotionMutation<TItem>,
    signal?: AbortSignal,
  ): Promise<{ row?: TItem; deletedKey?: string }> => {
    switch (mutation.type) {
      case 'insert': {
        const existing = await findPageByKey(mutation.key, signal)
        if (existing) {
          const row = config.schema.parsePage(existing)
          if (
            valuesEqual(
              config.schema.serialize(row),
              config.schema.serialize(mutation.value),
            )
          ) {
            return { row }
          }
          throw new NotionHttpError({
            status: 409,
            code: 'insert_key_exists',
            message: 'A Notion page already exists for this row key.',
            retryable: false,
          })
        }
        const created = await requestNotion<unknown>('/v1/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: {
              type: 'data_source_id',
              data_source_id: config.dataSourceId,
            },
            properties: config.schema.serialize(mutation.value),
          }),
          ...(signal ? { signal } : {}),
        })
        if (!isPage(created)) {
          throw new NotionHttpError({
            status: 502,
            code: 'invalid_notion_response',
            message: 'Notion returned an invalid page response.',
            retryable: true,
          })
        }
        return { row: config.schema.parsePage(created) }
      }
      case 'update': {
        const existing = await resolvePage(mutation, signal)
        if (!existing) {
          throw new NotionHttpError({
            status: 404,
            code: 'page_not_found',
            message: 'No Notion page was found for the requested row.',
            retryable: false,
          })
        }
        const remote = config.schema.parsePage(existing)
        const fields = Object.keys(mutation.changes) as Array<
          keyof TFields & string
        >
        const conflicts: Array<NotionPropertyConflict> = []
        const pending = new Set<keyof TFields & string>()
        for (const field of fields) {
          const localValue = mutation.value[field]
          const baseValue = mutation.base[field]
          const remoteValue = remote[field]
          if (!valuesEqual(mutation.changes[field], localValue)) {
            throw new NotionHttpError({
              status: 400,
              code: 'invalid_update_changes',
              message: 'An update change does not match its full row value.',
              retryable: false,
            })
          }
          if (
            !valuesEqual(remoteValue, baseValue) &&
            !valuesEqual(remoteValue, localValue)
          ) {
            conflicts.push({
              field,
              baseValue,
              localValue,
              remoteValue,
            })
          } else if (!valuesEqual(remoteValue, localValue)) {
            pending.add(field)
          }
        }
        if (conflicts.length > 0) {
          throw new NotionHttpError({
            status: 409,
            code: 'property_conflict',
            message: 'One or more changed properties were also edited in Notion.',
            retryable: false,
            conflicts,
          })
        }
        if (pending.size === 0) return { row: remote }
        return {
          row: await updatePage(existing.id, mutation.value, signal, pending),
        }
      }
      case 'delete': {
        const existing = await resolvePage(mutation, signal)
        if (existing) {
          await requestNotion(`/v1/pages/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ in_trash: true }),
            ...(signal ? { signal } : {}),
          })
        }
        return { deletedKey: mutation.key }
      }
    }
  }

  const applyBatch = async (
    batch: NotionMutationBatch<TItem>,
    signal?: AbortSignal,
  ): Promise<NotionMutationResult<TItem>> => {
    await ensureSchema(signal)
    if (batch.mutations.length === 0 || batch.mutations.length > 50) {
      throw new NotionHttpError({
        status: 400,
        code: 'invalid_batch_size',
        message: 'A mutation batch must contain between 1 and 50 mutations.',
        retryable: false,
      })
    }

    const rows: Array<TItem> = []
    const deletedKeys: Array<string> = []
    for (const [mutationIndex, mutation] of batch.mutations.entries()) {
      if (
        !mutation ||
        typeof mutation !== 'object' ||
        !['insert', 'update', 'delete'].includes(mutation.type) ||
        typeof mutation.key !== 'string' ||
        !mutation.value ||
        typeof mutation.value !== 'object'
      ) {
        throw new NotionHttpError({
          status: 400,
          code: 'invalid_mutation',
          message: 'The request contains an invalid mutation.',
          retryable: false,
        })
      }

      if (mutation.type === 'update') {
        if (!isRecord(mutation.base) || !isRecord(mutation.changes)) {
          throw new NotionHttpError({
            status: 400,
            code: 'invalid_update_changes',
            message: 'An update requires base and changes objects.',
            retryable: false,
          })
        }
        const changedFields = Object.keys(mutation.changes)
        if (changedFields.length === 0) {
          throw new NotionHttpError({
            status: 400,
            code: 'empty_update',
            message: 'An update must change at least one writable property.',
            retryable: false,
          })
        }
        for (const field of changedFields) {
          const descriptor = config.schema.fields[field]
          if (
            !descriptor ||
            descriptor.readonly ||
            field === config.schema.idField ||
            !Object.hasOwn(mutation.base, field)
          ) {
            throw new NotionHttpError({
              status: 400,
              code: 'invalid_update_field',
              message: `The update contains an unknown, read-only, identity, or unbased field (${field}).`,
              retryable: false,
            })
          }
        }
      }

      const validation = await config.schema['~standard'].validate(mutation.value)
      if ('issues' in validation) {
        throw new NotionSchemaError(
          'A mutation does not match the configured schema.',
          validation.issues,
        )
      }
      const normalized = { ...mutation, value: validation.value }
      if (config.schema.getKey(normalized.value) !== mutation.key) {
        throw new NotionHttpError({
          status: 400,
          code: 'key_mismatch',
          message: 'A mutation key does not match its row key.',
          retryable: false,
        })
      }

      const executeMutation = async () =>
        normalized.type === 'insert' && idempotencyStore
          ? await idempotencyStore.execute(
              {
                scope: `notion:${config.dataSourceId}:insert-key`,
                key: normalized.key,
                fingerprint: await fingerprint(
                  config.schema.serialize(normalized.value),
                ),
              },
              () => applyMutation(normalized, signal),
            )
          : await applyMutation(normalized, signal)
      const result = idempotencyStore
        ? await idempotencyStore.execute(
            {
              scope: `notion:${config.dataSourceId}:mutation`,
              key: `${batch.idempotencyKey}:${mutationIndex}`,
              fingerprint: await fingerprint(normalized),
            },
            executeMutation,
          )
        : await executeMutation()
      if (result.row) rows.push(result.row)
      if (result.deletedKey) deletedKeys.push(result.deletedKey)
    }
    return { rows, deletedKeys }
  }

  const assertPageBelongsToDataSource = async (
    pageId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const page = await requestNotion<Record<string, unknown>>(
      `/v1/pages/${encodeURIComponent(pageId)}`,
      signal ? { signal } : {},
    )
    const parent =
      page.parent && typeof page.parent === 'object'
        ? (page.parent as Record<string, unknown>)
        : null
    if (
      page.id !== pageId ||
      parent?.type !== 'data_source_id' ||
      parent.data_source_id !== config.dataSourceId
    ) {
      throw new NotionHttpError({
        status: 404,
        code: 'page_outside_data_source',
        message: 'The requested page is not part of this data source.',
        retryable: false,
      })
    }
  }

  const parsePageContent = (
    pageId: string,
    value: NotionMarkdownResponse,
  ): NotionPageContent => {
    if (
      value.object !== 'page_markdown' ||
      typeof value.markdown !== 'string' ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.unknown_block_ids)
    ) {
      throw new NotionHttpError({
        status: 502,
        code: 'invalid_notion_response',
        message: 'Notion returned an invalid page-content response.',
        retryable: true,
      })
    }
    return {
      pageId,
      markdown: value.markdown,
      truncated: value.truncated,
      unknownBlockIds: value.unknown_block_ids.filter(
        (id): id is string => typeof id === 'string',
      ),
    }
  }

  const retrievePageContent = async (
    pageId: string,
    signal?: AbortSignal,
  ): Promise<NotionPageContent> => {
    await assertPageBelongsToDataSource(pageId, signal)
    const response = await requestNotion<NotionMarkdownResponse>(
      `/v1/pages/${encodeURIComponent(pageId)}/markdown`,
      signal ? { signal } : {},
    )
    return parsePageContent(pageId, response)
  }

  const updatePageContent = async (
    mutation: NotionPageContentMutation,
    signal?: AbortSignal,
  ): Promise<NotionPageContent> => {
    const current = await retrievePageContent(mutation.pageId, signal)
    if (current.markdown === mutation.markdown) return current
    if (
      current.truncated ||
      current.unknownBlockIds.length > 0 ||
      current.markdown.includes('<unknown ')
    ) {
      throw new NotionHttpError({
        status: 409,
        code: 'page_content_incomplete',
        message:
          'The page contains content that cannot be represented completely; replacing it would risk data loss.',
        retryable: false,
      })
    }
    if (current.markdown !== mutation.baseMarkdown) {
      throw new NotionHttpError({
        status: 409,
        code: 'page_content_conflict',
        message: 'The page changed in Notion after this draft was loaded.',
        retryable: false,
      })
    }

    const response = await requestNotion<NotionMarkdownResponse>(
      `/v1/pages/${encodeURIComponent(mutation.pageId)}/markdown`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          type: 'replace_content',
          replace_content: { new_str: mutation.markdown },
        }),
        ...(signal ? { signal } : {}),
      },
    )
    return parsePageContent(mutation.pageId, response)
  }

  return async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
      if (config.authorize) {
        const authorization = await config.authorize(request)
        if (authorization instanceof Response) return authorization
        if (authorization !== true) {
          return json(
            {
              error: {
                code: 'unauthorized',
                message: 'Authentication is required to sync this collection.',
                retryable: false,
              },
            } satisfies NotionErrorBody,
            { status: 401 },
          )
        }
      }
      const url = new URL(request.url)

      if (request.method === 'GET' && url.searchParams.get('action') === 'content') {
        if (config.pageContent !== true) {
          throw new NotionHttpError({
            status: 404,
            code: 'page_content_disabled',
            message: 'Page-content synchronization is not enabled.',
            retryable: false,
          })
        }
        const pageId = url.searchParams.get('pageId')
        if (!pageId) {
          throw new NotionHttpError({
            status: 400,
            code: 'page_id_required',
            message: 'A pageId query parameter is required.',
            retryable: false,
          })
        }
        return json(await retrievePageContent(pageId, request.signal))
      }

      if (request.method === 'GET' && url.searchParams.get('action') === 'schema') {
        return json(await validateDataSource(request.signal))
      }

      if (
        request.method === 'GET' &&
        url.searchParams.get('action') === 'version'
      ) {
        if (!config.invalidationStore) {
          throw new NotionHttpError({
            status: 404,
            code: 'invalidation_disabled',
            message: 'Webhook-assisted invalidation is not enabled.',
            retryable: false,
          })
        }
        return json({
          version: await config.invalidationStore.getVersion(invalidationScope),
        })
      }

      if (request.method === 'GET') {
        const cursor = url.searchParams.get('cursor')
        const requestedSize = Number(url.searchParams.get('pageSize') ?? 100)
        const pageSize = Number.isFinite(requestedSize)
          ? Math.min(100, Math.max(1, Math.floor(requestedSize)))
          : 100
        return json(await list(cursor, pageSize, request.signal))
      }

      if (request.method === 'POST') {
        if (config.readOnly === true) {
          return json(
            {
              error: {
                code: 'read_only_collection',
                message: 'This Notion collection does not accept mutations.',
                retryable: false,
              },
            } satisfies NotionErrorBody,
            { status: 405, headers: { Allow: 'GET, OPTIONS' } },
          )
        }
        const body = await readJsonBody(request, maxRequestBodyBytes)
        if (isPageContentMutation(body)) {
          if (config.pageContent !== true) {
            throw new NotionHttpError({
              status: 404,
              code: 'page_content_disabled',
              message: 'Page-content synchronization is not enabled.',
              retryable: false,
            })
          }
          const content = await updatePageContent(body, request.signal)
          await config.invalidationStore?.invalidate(
            invalidationScope,
            `content:${body.idempotencyKey}`,
          )
          return json(content)
        }
        if (!isMutationBatch<TItem>(body)) {
          throw new NotionHttpError({
            status: 400,
            code: 'invalid_batch',
            message: 'Expected an idempotency key and a mutations array.',
            retryable: false,
          })
        }
        if (
          body.mutations.some((mutation) => mutation.type === 'insert') &&
          !idempotencyStore
        ) {
          throw new NotionHttpError({
            status: 500,
            code: 'idempotency_store_required',
            message:
              'Insert synchronization requires a durable idempotency store. Configure idempotencyStore on the server handler.',
            retryable: false,
          })
        }
        if (!idempotencyStore) {
          const result = await applyBatch(body, request.signal)
          await config.invalidationStore?.invalidate(
            invalidationScope,
            `mutation:${body.idempotencyKey}`,
          )
          return json(result)
        }
        try {
          const result = await idempotencyStore.execute(
              {
                scope: `notion:${config.dataSourceId}:mutations`,
                key: body.idempotencyKey,
                fingerprint: await fingerprint(body.mutations),
              },
              () => applyBatch(body, request.signal),
            )
          await config.invalidationStore?.invalidate(
            invalidationScope,
            `mutation:${body.idempotencyKey}`,
          )
          return json(result)
        } catch (error) {
          if (error instanceof NotionIdempotencyConflictError) {
            throw new NotionHttpError({
              status: 409,
              code: 'idempotency_key_reused',
              message: error.message,
              retryable: false,
            })
          }
          throw error
        }
      }

      return json(
        {
          error: {
            code: 'method_not_allowed',
            message: 'Only GET, POST, and OPTIONS are supported.',
            retryable: false,
          },
        } satisfies NotionErrorBody,
        { status: 405, headers: { Allow: 'GET, POST, OPTIONS' } },
      )
    } catch (error) {
      const notionError = error instanceof NotionHttpError ? error : null
      const schemaError = error instanceof NotionSchemaError ? error : null
      const status = notionError?.status ?? (schemaError ? 422 : 500)
      const body: NotionErrorBody = {
        error: {
          code:
            notionError?.code ??
            (schemaError ? 'schema_validation_failed' : 'internal_error'),
          message:
            notionError?.message ??
            (schemaError
              ? schemaError.message
              : 'The sync server encountered an unexpected error.'),
          retryable: notionError?.retryable ?? !schemaError,
          ...(notionError?.conflicts.length
            ? { conflicts: [...notionError.conflicts] }
            : {}),
        },
      }
      return json(body, { status })
    }
  }
}
