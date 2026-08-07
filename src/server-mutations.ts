import { NotionSchemaError } from './schema.js'
import type {
  InferNotionOutput,
  NotionFields,
  NotionPageLike,
  NotionSchema,
} from './schema.js'
import type {
  NotionMutation,
  NotionMutationBatch,
  NotionMutationResult,
  NotionPropertyConflict,
} from './protocol.js'
import { NotionHttpError } from './notion-request.js'

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

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`
}

export async function fingerprint(value: unknown): Promise<string> {
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

function looksLikePageId(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ) || /^[0-9a-f]{32}$/i.test(value)
  )
}

interface NotionListResponse {
  results?: Array<unknown>
  has_more?: boolean
  next_cursor?: string | null
}

interface CreateNotionMutationExecutorConfig<TFields extends NotionFields> {
  dataSourceId: string
  schema: NotionSchema<TFields>
  idempotencyStore: NotionIdempotencyStore | null
  ensureSchema: (signal?: AbortSignal) => Promise<void>
  queryPages: (
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<NotionListResponse>
  requestNotion: <T>(path: string, init?: RequestInit) => Promise<T>
}

type NotionMutationExecutor<TItem extends object> = (
  batch: NotionMutationBatch<TItem>,
  signal?: AbortSignal,
) => Promise<NotionMutationResult<TItem>>

export function createNotionMutationExecutor<
  const TFields extends NotionFields,
>(
  config: CreateNotionMutationExecutorConfig<TFields>,
): NotionMutationExecutor<InferNotionOutput<TFields>> {
  type TItem = InferNotionOutput<TFields>

  const idDescriptor = config.schema.fields[config.schema.idField]!
  const idPropertyName = idDescriptor.name ?? null
  const idPropertyReference = idDescriptor.propertyId ?? idPropertyName

  function hasClientId(page: NotionPageLike): boolean {
    for (const [name, value] of Object.entries(page.properties)) {
      if (!value || typeof value !== 'object') continue
      const property = value as Record<string, unknown>
      if (name !== idPropertyName && property.id !== idPropertyReference) {
        continue
      }
      const richText = Array.isArray(property.rich_text)
        ? property.rich_text
        : []
      return richText.some((item) => {
        if (!item || typeof item !== 'object') return false
        const record = item as Record<string, unknown>
        return (
          (typeof record.plain_text === 'string' && record.plain_text.length > 0) ||
          (typeof record.text === 'object' &&
            record.text !== null &&
            typeof (record.text as Record<string, unknown>).content ===
              'string' &&
            ((record.text as Record<string, unknown>).content as string)
              .length > 0)
        )
      })
    }
    return false
  }

  async function findPagesByKeys(
    keys: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, NotionPageLike>> {
    const requestedKeys = new Set(keys)
    const pagesByKey = new Map<string, NotionPageLike>()
    if (requestedKeys.size === 0) return pagesByKey
    if (!idPropertyName || !idPropertyReference) {
      throw new NotionHttpError({
        status: 405,
        code: 'read_only_key',
        message: 'A Notion page-ID key cannot be used for inserts.',
        retryable: false,
      })
    }

    const keyFilters = [...requestedKeys].map((key) => ({
      property: idPropertyReference,
      rich_text: { equals: key },
    }))
    const filter = keyFilters.length === 1 ? keyFilters[0]! : { or: keyFilters }
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    do {
      const response = await config.queryPages(
        {
          page_size: 100,
          filter,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        signal,
      )
      for (const page of (response.results ?? []).filter(isPage)) {
        const key = config.schema.getKey(config.schema.parsePage(page))
        if (!requestedKeys.has(key)) continue
        if (pagesByKey.has(key)) {
          throw new NotionHttpError({
            status: 409,
            code: 'duplicate_client_id',
            message: `More than one Notion page has the same ${idPropertyName} value.`,
            retryable: false,
          })
        }
        pagesByKey.set(key, page)
      }
      cursor =
        response.has_more === true && typeof response.next_cursor === 'string'
          ? response.next_cursor
          : null
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new NotionHttpError({
            status: 502,
            code: 'repeated_query_cursor',
            message: 'Notion repeated a pagination cursor during a key lookup.',
            retryable: true,
          })
        }
        seenCursors.add(cursor)
      }
    } while (cursor)
    return pagesByKey
  }

  async function resolvePage(
    mutation: NotionMutation<TItem>,
    signal?: AbortSignal,
    prefetchedPages?: Map<string, NotionPageLike>,
  ): Promise<NotionPageLike | null> {
    if (prefetchedPages) {
      const page = prefetchedPages.get(mutation.key) ?? null
      const suppliedPageId = config.schema.getPageId(mutation.value)
      if (page && suppliedPageId && suppliedPageId !== page.id) {
        throw new NotionHttpError({
          status: 409,
          code: 'page_identity_mismatch',
          message: 'The row key and Notion page ID identify different pages.',
          retryable: false,
        })
      }
      if (page) return page
    }

    const pageId =
      config.schema.getPageId(mutation.value) ??
      (looksLikePageId(mutation.key) ? mutation.key : null)
    if (!pageId) return null
    let page: unknown
    try {
      page = await config.requestNotion<unknown>(
        `/v1/pages/${encodeURIComponent(pageId)}`,
        signal ? { signal } : {},
      )
    } catch (error) {
      if (error instanceof NotionHttpError && error.status === 404) {
        return null
      }
      throw error
    }
    if (!isPage(page)) return null
    if (
      page.parent?.type !== 'data_source_id' ||
      page.parent.data_source_id !== config.dataSourceId
    ) {
      throw new NotionHttpError({
        status: 404,
        code: 'page_outside_data_source',
        message: 'The requested page is not part of this data source.',
        retryable: false,
      })
    }
    if (
      config.schema.getKey(config.schema.parsePage(page)) !== mutation.key
    ) {
      throw new NotionHttpError({
        status: 409,
        code: 'page_identity_mismatch',
        message: 'The row key and Notion page ID identify different pages.',
        retryable: false,
      })
    }
    return page
  }

  async function updatePage(
    pageId: string,
    value: TItem,
    signal?: AbortSignal,
    selectedFields?: ReadonlySet<keyof TFields & string>,
    backfillIdentity = false,
  ): Promise<TItem> {
    const fields = selectedFields
      ? new Set(selectedFields)
      : backfillIdentity
        ? new Set([config.schema.idField])
        : undefined
    if (backfillIdentity && fields) fields.add(config.schema.idField)
    const updated = await config.requestNotion<unknown>(
      `/v1/pages/${encodeURIComponent(pageId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          properties: config.schema.serialize(value, fields),
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

  async function applyMutation(
    mutation: NotionMutation<TItem>,
    signal?: AbortSignal,
    prefetchedPages?: Map<string, NotionPageLike>,
  ): Promise<{ row?: TItem; deletedKey?: string }> {
    switch (mutation.type) {
      case 'insert': {
        if (!prefetchedPages) {
          throw new NotionHttpError({
            status: 405,
            code: 'read_only_key',
            message: 'A Notion page-ID key cannot be used for inserts.',
            retryable: false,
          })
        }
        const existing = prefetchedPages.get(mutation.key) ?? null
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
        const created = await config.requestNotion<unknown>('/v1/pages', {
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
        prefetchedPages.set(mutation.key, created)
        return { row: config.schema.parsePage(created) }
      }
      case 'update': {
        const existing = await resolvePage(mutation, signal, prefetchedPages)
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
            conflicts.push({ field, baseValue, localValue, remoteValue })
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
          row: await updatePage(
            existing.id,
            mutation.value,
            signal,
            pending,
            !hasClientId(existing),
          ),
        }
      }
      case 'delete': {
        const existing = await resolvePage(mutation, signal, prefetchedPages)
        if (existing) {
          if (existing.in_trash) return { deletedKey: mutation.key }
          await config.requestNotion(
            `/v1/pages/${encodeURIComponent(existing.id)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ in_trash: true }),
              ...(signal ? { signal } : {}),
            },
          )
        } else if (
          !config.schema.getPageId(mutation.value) &&
          !looksLikePageId(mutation.key)
        ) {
          throw new NotionHttpError({
            status: 404,
            code: 'page_not_found',
            message: 'No Notion page was found for the requested row.',
            retryable: false,
          })
        }
        return { deletedKey: mutation.key }
      }
    }
  }

  return async function applyBatch(
    batch: NotionMutationBatch<TItem>,
    signal?: AbortSignal,
  ): Promise<NotionMutationResult<TItem>> {
    await config.ensureSchema(signal)
    if (batch.mutations.length === 0 || batch.mutations.length > 50) {
      throw new NotionHttpError({
        status: 400,
        code: 'invalid_batch_size',
        message: 'A mutation batch must contain between 1 and 50 mutations.',
        retryable: false,
      })
    }

    const normalizedMutations: Array<NotionMutation<TItem>> = []
    for (const mutation of batch.mutations) {
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
      const normalized = {
        ...mutation,
        value: validation.value,
      } as NotionMutation<TItem>
      if (config.schema.getKey(normalized.value) !== mutation.key) {
        throw new NotionHttpError({
          status: 400,
          code: 'key_mismatch',
          message: 'A mutation key does not match its row key.',
          retryable: false,
        })
      }
      normalizedMutations.push(normalized)
    }

    const prefetchedPages =
      idPropertyName && idPropertyReference
        ? await findPagesByKeys(
            normalizedMutations.map((mutation) => mutation.key),
            signal,
          )
        : undefined
    const rows: Array<TItem> = []
    const deletedKeys: Array<string> = []
    for (const [mutationIndex, normalized] of normalizedMutations.entries()) {
      const executeMutation = async () =>
        normalized.type === 'insert' && config.idempotencyStore
          ? await config.idempotencyStore.execute(
              {
                scope: `notion:${config.dataSourceId}:insert-key`,
                key: normalized.key,
                fingerprint: await fingerprint(
                  config.schema.serialize(normalized.value),
                ),
              },
              () => applyMutation(normalized, signal, prefetchedPages),
            )
          : await applyMutation(normalized, signal, prefetchedPages)
      const result = config.idempotencyStore
        ? await config.idempotencyStore.execute(
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
}
