import type { StandardSchemaV1 } from '@standard-schema/spec'

export type NotionFieldKind =
  | 'id'
  | 'title'
  | 'rich_text'
  | 'checkbox'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'url'
  | 'email'
  | 'phone_number'
  | 'status'
  | 'people'
  | 'files'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'created_by'
  | 'created_time'
  | 'last_edited_by'
  | 'last_edited_time'
  | 'unique_id'
  | 'place'
  | 'page_id'
  | 'page_url'

type NotionWritableFieldKind = Exclude<
  NotionFieldKind,
  'created_time' | 'last_edited_time' | 'page_id' | 'page_url'
>

export interface NotionField<
  TOutput,
  TInput = TOutput,
  TInputOptional extends boolean = false,
> {
  readonly kind: NotionFieldKind
  readonly name?: string
  /** Stable Notion property ID. Prefer this over the mutable display name. */
  readonly propertyId?: string
  readonly inputOptional: TInputOptional
  readonly readonly: boolean
  /** Preserve an unsupported Notion property as a typed `unknown` value. */
  readonly raw?: boolean
  /** Selects a richer local representation without changing the Notion type. */
  readonly representation?: 'rich_text_items' | 'date_range'
  readonly options?: readonly string[]
  readonly defaultValue?: () => TOutput
  readonly '~types'?: {
    readonly output: TOutput
    readonly input: TInput
  }
}

export type NotionFields = Record<
  string,
  NotionField<unknown, unknown, boolean>
>

type FieldOutput<TField> = TField extends NotionField<infer TOutput, any, any>
  ? TOutput
  : never

type FieldInput<TField> = TField extends NotionField<any, infer TInput, any>
  ? TInput
  : never

type Simplify<T> = { [TKey in keyof T]: T[TKey] } & {}

export type InferNotionOutput<TFields extends NotionFields> = Simplify<{
  -readonly [TKey in keyof TFields]: FieldOutput<TFields[TKey]>
}>

export type InferNotionInput<TFields extends NotionFields> = Simplify<
  {
    -readonly [TKey in keyof TFields as [FieldInput<TFields[TKey]>] extends [never]
      ? never
      : TFields[TKey]['inputOptional'] extends true
      ? never
      : TKey]: FieldInput<TFields[TKey]>
  } & {
    -readonly [TKey in keyof TFields as [FieldInput<TFields[TKey]>] extends [never]
      ? never
      : TFields[TKey]['inputOptional'] extends true
        ? TKey
        : never]?: FieldInput<TFields[TKey]>
  }
>

export interface NotionPageLike {
  id: string
  created_time: string
  last_edited_time: string
  url: string
  in_trash?: boolean
  properties: Record<string, unknown>
}

export type NotionPropertyValue = Record<string, unknown>

export interface NotionRichTextAnnotations {
  bold: boolean
  italic: boolean
  strikethrough: boolean
  underline: boolean
  code: boolean
  color: string
}

/** Lossless-enough rich text representation for round-tripping Notion values. */
export interface NotionRichTextItem {
  type: 'text' | 'mention' | 'equation' | (string & {})
  text?: { content: string; link: { url: string } | null }
  mention?: Record<string, unknown>
  equation?: { expression: string }
  annotations: NotionRichTextAnnotations
  plainText: string
  href: string | null
}

export interface NotionDateValue {
  start: string
  end: string | null
  timeZone: string | null
}

export interface NotionUserReference {
  id: string
  type?: 'person' | 'bot' | (string & {})
  name?: string | null
  avatarUrl?: string | null
  email?: string | null
}

export type NotionFileReference =
  | {
      name: string
      type: 'file'
      url: string
      expiryTime: string | null
    }
  | {
      name: string
      type: 'external'
      url: string
    }
  | {
      name: string
      type: 'file_upload'
      id: string
    }

export type NotionFormulaValue =
  | { type: 'string'; value: string | null }
  | { type: 'number'; value: number | null }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: NotionDateValue | null }
  | { type: 'unknown'; value: unknown }

export type NotionRollupValue =
  | { type: 'number'; value: number | null; function: string }
  | { type: 'date'; value: NotionDateValue | null; function: string }
  | { type: 'array'; value: Array<unknown>; function: string }
  | { type: 'incomplete' | 'unsupported' | 'unknown'; value: unknown; function: string }

export interface NotionUniqueIdValue {
  prefix: string | null
  number: number | null
}

export interface ExpectedNotionProperty {
  field: string
  name: string
  type: string
  propertyId?: string
}

export interface NotionPropertyReference {
  name: string
  /** The stable ID returned by Retrieve a data source. */
  id?: string
}

export type NotionPropertyReferenceInput = string | NotionPropertyReference

export class NotionSchemaError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>

  constructor(
    message: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue> = [],
  ) {
    super(message)
    this.name = 'NotionSchemaError'
    this.issues = issues
  }
}

export interface NotionSchema<TFields extends NotionFields>
  extends StandardSchemaV1<
    InferNotionInput<TFields>,
    InferNotionOutput<TFields>
  > {
  readonly fields: TFields
  readonly idField: keyof TFields & string
  readonly titleField: keyof TFields & string
  parsePage: (page: NotionPageLike) => InferNotionOutput<TFields>
  serialize: (
    row: InferNotionOutput<TFields>,
    fields?: ReadonlySet<keyof TFields & string>,
  ) => Record<string, NotionPropertyValue>
  getKey: (row: InferNotionOutput<TFields>) => string
  getPageId: (row: InferNotionOutput<TFields>) => string | null
  expectedProperties: () => ReadonlyArray<ExpectedNotionProperty>
}

type OptionalStringField = NotionField<string, string, true>
type ReadOnlyStringField = NotionField<string, never, true>
type OptionalNullableStringField = NotionField<
  string | null,
  string | null,
  true
>

const defaultAnnotations = (): NotionRichTextAnnotations => ({
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
})

function field<TOutput, TInput = TOutput, TOptional extends boolean = false>(
  value: Omit<NotionField<TOutput, TInput, TOptional>, '~types'>,
): NotionField<TOutput, TInput, TOptional> {
  return value
}

function reference(
  value: NotionPropertyReferenceInput | undefined,
  fallback?: string,
): Pick<NotionField<unknown, unknown, boolean>, 'name' | 'propertyId'> {
  if (typeof value === 'string') return { name: value }
  if (value) {
    return {
      name: value.name,
      ...(value.id ? { propertyId: value.id } : {}),
    }
  }
  return fallback ? { name: fallback } : {}
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16)
    const nibble = token === 'x' ? value : (value & 0x3) | 0x8
    return nibble.toString(16)
  })
}

function now(): string {
  return new Date().toISOString()
}

export const notion = {
  id(
    property: NotionPropertyReferenceInput = 'Client ID',
  ): NotionField<string, string, true> {
    return field({
      kind: 'id',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: randomId,
    })
  },

  title(property: NotionPropertyReferenceInput = 'Name'): NotionField<string> {
    return field({
      kind: 'title',
      ...reference(property),
      inputOptional: false,
      readonly: false,
    })
  },

  titleItems(
    property: NotionPropertyReferenceInput = 'Name',
  ): NotionField<Array<NotionRichTextItem>> {
    return field({
      kind: 'title',
      ...reference(property),
      inputOptional: false,
      readonly: false,
      representation: 'rich_text_items',
    })
  },

  richText(
    property: NotionPropertyReferenceInput,
    defaultValue = '',
  ): OptionalStringField {
    return field({
      kind: 'rich_text',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => defaultValue,
    })
  },

  richTextItems(
    property: NotionPropertyReferenceInput,
  ): NotionField<
    Array<NotionRichTextItem>,
    Array<NotionRichTextItem>,
    true
  > {
    return field({
      kind: 'rich_text',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      representation: 'rich_text_items',
      defaultValue: () => [],
    })
  },

  checkbox(
    property: NotionPropertyReferenceInput,
    defaultValue = false,
  ): NotionField<boolean, boolean, true> {
    return field({
      kind: 'checkbox',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => defaultValue,
    })
  },

  number(
    property: NotionPropertyReferenceInput,
  ): NotionField<number | null, number | null, true> {
    return field({
      kind: 'number',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => null,
    })
  },

  select<const TOptions extends readonly string[]>(
    property: NotionPropertyReferenceInput,
    options: TOptions,
    defaultValue: TOptions[number] | null = null,
  ): NotionField<TOptions[number] | null, TOptions[number] | null, true> {
    return field({
      kind: 'select',
      ...reference(property),
      options,
      inputOptional: true,
      readonly: false,
      defaultValue: () => defaultValue,
    })
  },

  multiSelect<const TOptions extends readonly string[]>(
    property: NotionPropertyReferenceInput,
    options: TOptions,
  ): NotionField<Array<TOptions[number]>, Array<TOptions[number]>, true> {
    return field({
      kind: 'multi_select',
      ...reference(property),
      options,
      inputOptional: true,
      readonly: false,
      defaultValue: () => [],
    })
  },

  date(property: NotionPropertyReferenceInput): OptionalNullableStringField {
    return field({
      kind: 'date',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => null,
    })
  },

  dateRange(
    property: NotionPropertyReferenceInput,
  ): NotionField<NotionDateValue | null, NotionDateValue | null, true> {
    return field({
      kind: 'date',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      representation: 'date_range',
      defaultValue: () => null,
    })
  },

  url(property: NotionPropertyReferenceInput): OptionalNullableStringField {
    return field({
      kind: 'url',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => null,
    })
  },

  email(property: NotionPropertyReferenceInput): OptionalNullableStringField {
    return field({
      kind: 'email',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => null,
    })
  },

  phoneNumber(
    property: NotionPropertyReferenceInput,
  ): OptionalNullableStringField {
    return field({
      kind: 'phone_number',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => null,
    })
  },

  status<const TOptions extends readonly string[]>(
    property: NotionPropertyReferenceInput,
    options: TOptions,
    defaultValue: TOptions[number] | null = null,
  ): NotionField<TOptions[number] | null, TOptions[number] | null, true> {
    return field({
      kind: 'status',
      ...reference(property),
      options,
      inputOptional: true,
      readonly: false,
      defaultValue: () => defaultValue,
    })
  },

  people(
    property: NotionPropertyReferenceInput,
  ): NotionField<Array<NotionUserReference>, Array<NotionUserReference>, true> {
    return field({
      kind: 'people',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => [],
    })
  },

  relation(
    property: NotionPropertyReferenceInput,
  ): NotionField<Array<{ id: string }>, Array<{ id: string }>, true> {
    return field({
      kind: 'relation',
      ...reference(property),
      inputOptional: true,
      readonly: false,
      defaultValue: () => [],
    })
  },

  files(
    property: NotionPropertyReferenceInput,
  ): NotionField<Array<NotionFileReference>, never, true> {
    return field<Array<NotionFileReference>, never, true>({
      kind: 'files',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: () => [],
    })
  },

  formula(
    property: NotionPropertyReferenceInput,
  ): NotionField<NotionFormulaValue | null, never, true> {
    return field<NotionFormulaValue | null, never, true>({
      kind: 'formula',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  rollup(
    property: NotionPropertyReferenceInput,
  ): NotionField<NotionRollupValue | null, never, true> {
    return field<NotionRollupValue | null, never, true>({
      kind: 'rollup',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  createdBy(
    property: NotionPropertyReferenceInput,
  ): NotionField<NotionUserReference | null, never, true> {
    return field<NotionUserReference | null, never, true>({
      kind: 'created_by',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  lastEditedBy(
    property: NotionPropertyReferenceInput,
  ): NotionField<NotionUserReference | null, never, true> {
    return field<NotionUserReference | null, never, true>({
      kind: 'last_edited_by',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  uniqueId(
    property: NotionPropertyReferenceInput,
  ): NotionField<NotionUniqueIdValue | null, never, true> {
    return field<NotionUniqueIdValue | null, never, true>({
      kind: 'unique_id',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  createdTime(property?: NotionPropertyReferenceInput): ReadOnlyStringField {
    return field<string, never, true>({
      kind: 'created_time',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: now,
    })
  },

  lastEditedTime(property?: NotionPropertyReferenceInput): ReadOnlyStringField {
    return field<string, never, true>({
      kind: 'last_edited_time',
      ...reference(property),
      inputOptional: true,
      readonly: true,
      defaultValue: now,
    })
  },

  pageId(): NotionField<string | null, never, true> {
    return field<string | null, never, true>({
      kind: 'page_id',
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  pageUrl(): NotionField<string | null, never, true> {
    return field<string | null, never, true>({
      kind: 'page_url',
      inputOptional: true,
      readonly: true,
      defaultValue: () => null,
    })
  },

  /**
   * Keeps a property that does not yet have a first-class codec in generated
   * schemas. Raw properties are read-only and intentionally typed as unknown.
   */
  raw(
    property: NotionPropertyReferenceInput,
    kind: Exclude<NotionFieldKind, 'id' | 'page_id' | 'page_url'>,
  ): NotionField<unknown, never, true> {
    return field<unknown, never, true>({
      kind,
      ...reference(property),
      inputOptional: true,
      readonly: true,
      raw: true,
      defaultValue: () => null,
    })
  },
} as const

function propertyType(kind: NotionFieldKind): string | null {
  switch (kind) {
    case 'id':
      return 'rich_text'
    case 'page_id':
    case 'page_url':
      return null
    default:
      return kind
  }
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.plain_text === 'string') return record.plain_text
      const text = record.text as Record<string, unknown> | undefined
      return typeof text?.content === 'string' ? text.content : ''
    })
    .join('')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function richTextItems(value: unknown): Array<NotionRichTextItem> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = asRecord(entry)
    if (!item || typeof item.type !== 'string') return []
    const annotationValue = asRecord(item.annotations)
    const annotations: NotionRichTextAnnotations = {
      bold: annotationValue?.bold === true,
      italic: annotationValue?.italic === true,
      strikethrough: annotationValue?.strikethrough === true,
      underline: annotationValue?.underline === true,
      code: annotationValue?.code === true,
      color:
        typeof annotationValue?.color === 'string'
          ? annotationValue.color
          : 'default',
    }
    const normalized: NotionRichTextItem = {
      type: item.type,
      annotations,
      plainText:
        typeof item.plain_text === 'string'
          ? item.plain_text
          : plainText([item]),
      href: typeof item.href === 'string' ? item.href : null,
    }
    if (item.type === 'text') {
      const text = asRecord(item.text)
      const link = asRecord(text?.link)
      normalized.text = {
        content: typeof text?.content === 'string' ? text.content : '',
        link: typeof link?.url === 'string' ? { url: link.url } : null,
      }
    } else if (item.type === 'mention') {
      normalized.mention = structuredClone(asRecord(item.mention) ?? {})
    } else if (item.type === 'equation') {
      const equation = asRecord(item.equation)
      normalized.equation = {
        expression:
          typeof equation?.expression === 'string' ? equation.expression : '',
      }
    }
    return [normalized]
  })
}

function dateValue(value: unknown): NotionDateValue | null {
  const date = asRecord(value)
  if (!date || typeof date.start !== 'string') return null
  return {
    start: date.start,
    end: typeof date.end === 'string' ? date.end : null,
    timeZone: typeof date.time_zone === 'string' ? date.time_zone : null,
  }
}

function userReference(value: unknown): NotionUserReference | null {
  const user = asRecord(value)
  if (!user || typeof user.id !== 'string') return null
  const person = asRecord(user.person)
  return {
    id: user.id,
    ...(typeof user.type === 'string'
      ? {
          type: user.type as Exclude<
            NotionUserReference['type'],
            undefined
          >,
        }
      : {}),
    ...(typeof user.name === 'string' || user.name === null
      ? { name: user.name }
      : {}),
    ...(typeof user.avatar_url === 'string' || user.avatar_url === null
      ? { avatarUrl: user.avatar_url }
      : {}),
    ...(typeof person?.email === 'string' ? { email: person.email } : {}),
  }
}

function fileReferences(value: unknown): Array<NotionFileReference> {
  if (!Array.isArray(value)) return []
  return value.flatMap<NotionFileReference>((entry) => {
    const file = asRecord(entry)
    if (!file || typeof file.name !== 'string' || typeof file.type !== 'string') {
      return []
    }
    if (file.type === 'file') {
      const hosted = asRecord(file.file)
      return typeof hosted?.url === 'string'
        ? [{
            name: file.name,
            type: 'file' as const,
            url: hosted.url,
            expiryTime:
              typeof hosted.expiry_time === 'string' ? hosted.expiry_time : null,
          }]
        : []
    }
    if (file.type === 'external') {
      const external = asRecord(file.external)
      return typeof external?.url === 'string'
        ? [{ name: file.name, type: 'external' as const, url: external.url }]
        : []
    }
    if (file.type === 'file_upload') {
      const upload = asRecord(file.file_upload)
      return typeof upload?.id === 'string'
        ? [{ name: file.name, type: 'file_upload' as const, id: upload.id }]
        : []
    }
    return []
  })
}

function formulaValue(value: unknown): NotionFormulaValue | null {
  const formula = asRecord(value)
  if (!formula || typeof formula.type !== 'string') return null
  switch (formula.type) {
    case 'string':
      return {
        type: 'string',
        value: typeof formula.string === 'string' ? formula.string : null,
      }
    case 'number':
      return {
        type: 'number',
        value: typeof formula.number === 'number' ? formula.number : null,
      }
    case 'boolean':
      return { type: 'boolean', value: formula.boolean === true }
    case 'date':
      return { type: 'date', value: dateValue(formula.date) }
    default:
      return { type: 'unknown', value: structuredClone(value) }
  }
}

function rollupValue(value: unknown): NotionRollupValue | null {
  const rollup = asRecord(value)
  if (!rollup || typeof rollup.type !== 'string') return null
  const rollupFunction =
    typeof rollup.function === 'string' ? rollup.function : 'unknown'
  switch (rollup.type) {
    case 'number':
      return {
        type: 'number',
        value: typeof rollup.number === 'number' ? rollup.number : null,
        function: rollupFunction,
      }
    case 'date':
      return {
        type: 'date',
        value: dateValue(rollup.date),
        function: rollupFunction,
      }
    case 'array':
      return {
        type: 'array',
        value: Array.isArray(rollup.array)
          ? structuredClone(rollup.array)
          : [],
        function: rollupFunction,
      }
    case 'incomplete':
    case 'unsupported':
      return {
        type: rollup.type,
        value: structuredClone(rollup[rollup.type]),
        function: rollupFunction,
      }
    default:
      return {
        type: 'unknown',
        value: structuredClone(value),
        function: rollupFunction,
      }
  }
}

function readProperty(
  descriptor: NotionField<unknown, unknown, boolean>,
  property: unknown,
  page: NotionPageLike,
): unknown {
  const record =
    property && typeof property === 'object'
      ? (property as Record<string, unknown>)
      : {}

  if (descriptor.raw) return record[descriptor.kind] ?? null

  switch (descriptor.kind) {
    case 'id': {
      const value = plainText(record.rich_text)
      return value || page.id
    }
    case 'title':
      return descriptor.representation === 'rich_text_items'
        ? richTextItems(record.title)
        : plainText(record.title)
    case 'rich_text':
      return descriptor.representation === 'rich_text_items'
        ? richTextItems(record.rich_text)
        : plainText(record.rich_text)
    case 'checkbox':
      return record.checkbox ?? false
    case 'number':
      return record.number ?? null
    case 'select':
    case 'status': {
      const option = record[descriptor.kind]
      return option && typeof option === 'object'
        ? ((option as Record<string, unknown>).name ?? null)
        : null
    }
    case 'multi_select':
      return Array.isArray(record.multi_select)
        ? record.multi_select
            .map((option) =>
              option && typeof option === 'object'
                ? (option as Record<string, unknown>).name
                : undefined,
            )
            .filter((value): value is string => typeof value === 'string')
        : []
    case 'date': {
      const date = dateValue(record.date)
      return descriptor.representation === 'date_range'
        ? date
        : date?.start ?? null
    }
    case 'url':
    case 'email':
    case 'phone_number':
      return record[descriptor.kind] ?? null
    case 'created_time':
      return record.created_time ?? page.created_time
    case 'last_edited_time':
      return record.last_edited_time ?? page.last_edited_time
    case 'people':
      return Array.isArray(record.people)
        ? record.people.flatMap((value) => {
            const user = userReference(value)
            return user ? [user] : []
          })
        : []
    case 'files':
      return fileReferences(record.files)
    case 'formula':
      return formulaValue(record.formula)
    case 'relation':
      return Array.isArray(record.relation)
        ? record.relation.flatMap((value) => {
            const relation = asRecord(value)
            return typeof relation?.id === 'string' ? [{ id: relation.id }] : []
          })
        : []
    case 'rollup':
      return rollupValue(record.rollup)
    case 'created_by':
      return userReference(record.created_by)
    case 'last_edited_by':
      return userReference(record.last_edited_by)
    case 'unique_id': {
      const uniqueId = asRecord(record.unique_id)
      return uniqueId
        ? {
            prefix:
              typeof uniqueId.prefix === 'string' ? uniqueId.prefix : null,
            number:
              typeof uniqueId.number === 'number' ? uniqueId.number : null,
          }
        : null
    }
    case 'place':
      return record[descriptor.kind] ?? null
    case 'page_id':
      return page.id
    case 'page_url':
      return page.url
  }
}

function richText(content: string): Array<Record<string, unknown>> {
  return content.length === 0
    ? []
    : [{ type: 'text', text: { content, link: null } }]
}

function writeRichTextItems(
  items: Array<NotionRichTextItem>,
): Array<Record<string, unknown>> {
  return items.map((item) => {
    const base: Record<string, unknown> = {
      type: item.type,
      annotations: { ...item.annotations },
    }
    if (item.type === 'text') {
      base.text = {
        content: item.text?.content ?? item.plainText,
        link: item.text?.link ? { ...item.text.link } : null,
      }
    } else if (item.type === 'mention') {
      base.mention = structuredClone(item.mention ?? {})
    } else if (item.type === 'equation') {
      base.equation = {
        expression: item.equation?.expression ?? item.plainText,
      }
    }
    return base
  })
}

function writeProperty(
  descriptor: NotionField<unknown, unknown, boolean>,
  value: unknown,
): NotionPropertyValue | undefined {
  switch (descriptor.kind as NotionWritableFieldKind) {
    case 'id':
      return { rich_text: richText(value as string) }
    case 'rich_text':
      return {
        rich_text:
          descriptor.representation === 'rich_text_items'
            ? writeRichTextItems(value as Array<NotionRichTextItem>)
            : richText(value as string),
      }
    case 'title':
      return {
        title:
          descriptor.representation === 'rich_text_items'
            ? writeRichTextItems(value as Array<NotionRichTextItem>)
            : richText(value as string),
      }
    case 'checkbox':
      return { checkbox: value }
    case 'number':
      return { number: value }
    case 'select':
      return { select: value === null ? null : { name: value } }
    case 'multi_select':
      return {
        multi_select: (value as string[]).map((name) => ({ name })),
      }
    case 'date':
      return {
        date:
          value === null
            ? null
            : descriptor.representation === 'date_range'
              ? {
                  start: (value as NotionDateValue).start,
                  end: (value as NotionDateValue).end,
                  time_zone: (value as NotionDateValue).timeZone,
                }
              : { start: value },
      }
    case 'url':
      return { url: value }
    case 'email':
      return { email: value }
    case 'phone_number':
      return { phone_number: value }
    case 'status':
      return { status: value === null ? null : { name: value } }
    case 'people':
      return {
        people: (value as Array<NotionUserReference>).map(({ id }) => ({ id })),
      }
    case 'relation':
      return {
        relation: (value as Array<{ id: string }>).map(({ id }) => ({ id })),
      }
    default:
      return undefined
  }
}

function validateField(
  key: string,
  descriptor: NotionField<unknown, unknown, boolean>,
  value: unknown,
): StandardSchemaV1.Issue | undefined {
  if (descriptor.raw) return undefined

  const issue = (expected: string): StandardSchemaV1.Issue => ({
    message: `Expected ${expected}`,
    path: [key],
  })

  switch (descriptor.kind) {
    case 'checkbox':
      return typeof value === 'boolean' ? undefined : issue('a boolean')
    case 'number':
      return value === null || (typeof value === 'number' && Number.isFinite(value))
        ? undefined
        : issue('a finite number or null')
    case 'select':
    case 'status':
      return value === null ||
        (typeof value === 'string' && descriptor.options?.includes(value))
        ? undefined
        : issue(`one of ${descriptor.options?.join(', ') ?? 'the configured options'}`)
    case 'multi_select':
      return Array.isArray(value) &&
        value.every(
          (item) =>
            typeof item === 'string' && descriptor.options?.includes(item),
        )
        ? undefined
        : issue('an array of configured options')
    case 'title':
    case 'rich_text':
      if (descriptor.representation === 'rich_text_items') {
        return Array.isArray(value) &&
          value.every(
            (item) =>
              asRecord(item) !== null &&
              typeof (item as NotionRichTextItem).type === 'string' &&
              typeof (item as NotionRichTextItem).plainText === 'string' &&
              asRecord((item as NotionRichTextItem).annotations) !== null,
          )
          ? undefined
          : issue('an array of Notion rich text items')
      }
      return typeof value === 'string' ? undefined : issue('a string')
    case 'date':
      if (descriptor.representation === 'date_range') {
        return value === null ||
          (asRecord(value) !== null &&
            typeof (value as NotionDateValue).start === 'string' &&
            !Number.isNaN(Date.parse((value as NotionDateValue).start)) &&
            ((value as NotionDateValue).end === null ||
              (typeof (value as NotionDateValue).end === 'string' &&
                !Number.isNaN(Date.parse((value as NotionDateValue).end!)))) &&
            ((value as NotionDateValue).timeZone === null ||
              typeof (value as NotionDateValue).timeZone === 'string'))
          ? undefined
          : issue('a Notion date range or null')
      }
      return value === null ||
        (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
        ? undefined
        : issue('an ISO date string or null')
    case 'url':
    case 'email':
    case 'phone_number':
    case 'page_id':
    case 'page_url':
      return value === null || typeof value === 'string'
        ? undefined
        : issue('a string or null')
    case 'people':
      return Array.isArray(value) &&
        value.every((user) => typeof asRecord(user)?.id === 'string')
        ? undefined
        : issue('an array of Notion user references')
    case 'relation':
      return Array.isArray(value) &&
        value.every((relation) => typeof asRecord(relation)?.id === 'string')
        ? undefined
        : issue('an array of Notion page references')
    case 'files':
      return Array.isArray(value) ? undefined : issue('an array of Notion files')
    case 'formula':
    case 'rollup':
    case 'created_by':
    case 'last_edited_by':
    case 'unique_id':
      return value === null || asRecord(value) !== null
        ? undefined
        : issue('a Notion property value or null')
    case 'place':
      return undefined
    default:
      return typeof value === 'string' ? undefined : issue('a string')
  }
}

function propertyIdMatches(left: string, right: string): boolean {
  if (left === right) return true
  try {
    return decodeURIComponent(left) === decodeURIComponent(right)
  } catch {
    return false
  }
}

function pageProperty(
  page: NotionPageLike,
  descriptor: NotionField<unknown, unknown, boolean>,
): unknown {
  if (descriptor.propertyId) {
    for (const property of Object.values(page.properties)) {
      if (!property || typeof property !== 'object') continue
      const id = (property as Record<string, unknown>).id
      if (
        typeof id === 'string' &&
        propertyIdMatches(id, descriptor.propertyId)
      ) {
        return property
      }
    }
  }
  return descriptor.name ? page.properties[descriptor.name] : undefined
}

export function notionSchema<const TFields extends NotionFields>(
  fields: TFields,
): NotionSchema<TFields> {
  const entries = Object.entries(fields) as Array<
    [keyof TFields & string, TFields[keyof TFields]]
  >
  const idFields = entries.filter(([, descriptor]) => descriptor.kind === 'id')
  const pageIdFields = entries.filter(
    ([, descriptor]) => descriptor.kind === 'page_id',
  )
  const titleFields = entries.filter(
    ([, descriptor]) => descriptor.kind === 'title',
  )

  if (idFields.length > 1 || (idFields.length === 0 && pageIdFields.length !== 1)) {
    throw new NotionSchemaError(
      'A Notion schema must define exactly one notion.id() field, or one notion.pageId() field for a read-only collection.',
    )
  }
  if (titleFields.length !== 1) {
    throw new NotionSchemaError(
      `A Notion schema must define exactly one notion.title() field; received ${titleFields.length}.`,
    )
  }

  const propertyNames = entries
    .map(([, descriptor]) => descriptor.name)
    .filter((name): name is string => name !== undefined)
  if (new Set(propertyNames).size !== propertyNames.length) {
    throw new NotionSchemaError('Notion property names must be unique.')
  }
  const propertyIds = entries
    .map(([, descriptor]) => descriptor.propertyId)
    .filter((id): id is string => id !== undefined)
  if (new Set(propertyIds).size !== propertyIds.length) {
    throw new NotionSchemaError('Notion property IDs must be unique.')
  }

  const idField = (idFields[0] ?? pageIdFields[0])![0]
  const titleField = titleFields[0]![0]

  const validate = (
    input: unknown,
  ): StandardSchemaV1.Result<InferNotionOutput<TFields>> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { issues: [{ message: 'Expected an object' }] }
    }

    const source = input as Record<string, unknown>
    const output: Record<string, unknown> = {}
    const issues: Array<StandardSchemaV1.Issue> = []

    for (const [key, descriptor] of entries) {
      const value =
        source[key] === undefined && descriptor.defaultValue
          ? descriptor.defaultValue()
          : source[key]
      const fieldIssue = validateField(key, descriptor, value)
      if (fieldIssue) issues.push(fieldIssue)
      else output[key] = value
    }

    return issues.length > 0
      ? { issues }
      : { value: output as InferNotionOutput<TFields> }
  }

  const schema: NotionSchema<TFields> = {
    fields,
    idField,
    titleField,
    '~standard': {
      version: 1,
      vendor: 'tanstack-db-notion-adapter',
      validate,
    },
    parsePage(page) {
      const row: Record<string, unknown> = {}
      for (const [key, descriptor] of entries) {
        row[key] = readProperty(descriptor, pageProperty(page, descriptor), page)
      }

      const result = validate(row)
      if ('issues' in result) {
        throw new NotionSchemaError(
          `Notion page ${page.id} does not match the configured schema.`,
          result.issues,
        )
      }
      return result.value
    },
    serialize(row, selectedFields) {
      const properties: Record<string, NotionPropertyValue> = {}
      for (const [key, descriptor] of entries) {
        if (
          descriptor.readonly ||
          !descriptor.name ||
          (selectedFields && !selectedFields.has(key))
        ) {
          continue
        }
        const property = writeProperty(descriptor, row[key])
        if (property) {
          properties[descriptor.propertyId ?? descriptor.name] = property
        }
      }
      return properties
    },
    getKey(row) {
      const value = row[idField]
      if (typeof value !== 'string' || value.length === 0) {
        throw new NotionSchemaError(
          `The configured key field "${idField}" does not contain a Notion page ID or stable client ID.`,
        )
      }
      return value
    },
    getPageId(row) {
      const pageIdField = entries.find(
        ([, descriptor]) => descriptor.kind === 'page_id',
      )
      return pageIdField ? (row[pageIdField[0]] as string | null) : null
    },
    expectedProperties() {
      return entries.flatMap(([key, descriptor]) => {
        const type = propertyType(descriptor.kind)
        if (!type || !descriptor.name) return []
        return [
          {
            field: key,
            name: descriptor.name,
            type,
            ...(descriptor.propertyId
              ? { propertyId: descriptor.propertyId }
              : {}),
          },
        ]
      })
    },
  }

  return schema
}
