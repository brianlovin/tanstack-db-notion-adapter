export type NotionMutation<TItem extends object> =
  | { type: 'insert'; key: string; value: TItem }
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
}

export interface NotionListResult<TItem extends object> {
  rows: Array<TItem>
  hasMore: boolean
  nextCursor: string | null
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
