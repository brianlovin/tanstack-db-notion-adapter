export type NotionMutation<TItem extends object> =
  | {
      type: 'insert'
      key: string
      value: TItem
      /**
       * Optional fresh identity for an intentional insert replay, such as
       * recreating a row whose original insert was already acknowledged.
       */
      idempotencyKey?: string
    }
  | {
      type: 'update'
      key: string
      value: TItem
      /** Values observed before the local edit, limited to changed fields. */
      base: Partial<TItem>
      /** Only fields intentionally changed by this mutation. */
      changes: Partial<TItem>
    }
  | { type: 'delete'; key: string; value: TItem }

export interface NotionPropertyConflict {
  /** Stable client-owned row identity for the conflicting update. */
  key: string
  /** Zero-based position of the update in its mutation batch. */
  mutationIndex: number
  field: string
  baseValue: unknown
  localValue: unknown
  remoteValue: unknown
}

export interface NotionMutationBatch<TItem extends object> {
  idempotencyKey: string
  mutations: Array<NotionMutation<TItem>>
}

export interface NotionMutationResult<TItem extends object> {
  rows: Array<TItem>
  deletedKeys: Array<string>
  /**
   * Version transition caused by this batch. A client may advance through this
   * checkpoint only when it had already observed versionBefore and no other
   * invalidation was interleaved with the mutation.
   */
  invalidation?: {
    versionBefore: number
    versionAfter: number
  }
}

export interface NotionListResult<TItem extends object> {
  rows: Array<TItem>
  hasMore: boolean
  nextCursor: string | null
  /** Greatest Notion last_edited_time observed in this response page. */
  watermark?: string
  /** Shared invalidation version observed around this Notion query. */
  version?: number
}

export interface NotionInvalidationVersion {
  version: number
}

export interface NotionPageContent {
  pageId: string
  markdown: string
  truncated: boolean
  unknownBlockIds: Array<string>
}

export interface NotionPageContentMutation {
  type: 'page_content'
  idempotencyKey: string
  pageId: string
  baseMarkdown: string
  markdown: string
}

export interface NotionSchemaMismatch {
  field: string
  name: string
  expected: string
  actual: string | null
}

export interface NotionSchemaResult {
  ok: boolean
  dataSourceId: string
  mismatches: Array<NotionSchemaMismatch>
}

export interface NotionErrorBody {
  error: {
    code: string
    message: string
    retryable: boolean
    conflicts?: Array<NotionPropertyConflict>
  }
}
