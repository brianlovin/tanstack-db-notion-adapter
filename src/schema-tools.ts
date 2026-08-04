import {
  LATEST_NOTION_VERSION,
  resolveNotionDataSourceId,
} from './server.js'

export type NotionDataSourcePropertyType =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'people'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone_number'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'
  | 'unique_id'
  | 'place'
  | (string & {})

export interface NotionSchemaOption {
  id?: string
  name: string
  color?: string
}

export interface NotionDataSourcePropertySnapshot {
  id: string
  name: string
  type: NotionDataSourcePropertyType
  options?: Array<NotionSchemaOption>
  config: Record<string, unknown>
}

export interface NotionDataSourceSnapshot {
  notionVersion: string
  dataSourceId: string
  name: string | null
  properties: Array<NotionDataSourcePropertySnapshot>
}

export interface InspectNotionDataSourceConfig {
  token: string
  /** A data source ID, or a database ID with exactly one data source. */
  id: string
  notionVersion?: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

export interface NotionManifestProperty {
  /** Stable TypeScript object key used by the generated row type. */
  key: string
  /** Stable Notion property ID. Missing until a new local property is pushed. */
  propertyId?: string
  name: string
  type: NotionDataSourcePropertyType
  options?: Array<NotionSchemaOption>
  defaultValue?: string | number | boolean | null | Array<string>
  /** Type-specific schema returned by Notion. Preserved for complex properties. */
  config?: Record<string, unknown>
}

export interface NotionSchemaManifest {
  /** Optional editor hint for the published manifest JSON Schema. */
  $schema?: string
  version: 1
  notionVersion: string
  /** IDs are identifiers, not credentials. Runtime authentication remains in env. */
  dataSourceId?: string
  exportName: string
  syncKey: {
    key: string
    name: string
    propertyId?: string
  }
  metadata: {
    pageId: string
    pageUrl: string
    createdTime: string
    lastEditedTime: string
  }
  properties: Array<NotionManifestProperty>
}

export interface NotionManifestValidationIssue {
  path: string
  message: string
}

const typescriptIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const reservedBindings = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Validates the checked-in manifest before generation or network access. */
export function validateNotionSchemaManifest(
  value: unknown,
): Array<NotionManifestValidationIssue> {
  const issues: Array<NotionManifestValidationIssue> = []
  const manifest = record(value)
  const requireString = (
    source: Record<string, unknown> | null,
    key: string,
    path: string,
  ): string | null => {
    const candidate = source?.[key]
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      issues.push({ path, message: 'Expected a non-empty string.' })
      return null
    }
    return candidate
  }
  if (!manifest) return [{ path: '$', message: 'Expected a JSON object.' }]
  if (manifest.version !== 1) {
    issues.push({ path: 'version', message: 'Expected manifest version 1.' })
  }
  const notionVersion = requireString(manifest, 'notionVersion', 'notionVersion')
  if (notionVersion && !/^\d{4}-\d{2}-\d{2}$/.test(notionVersion)) {
    issues.push({
      path: 'notionVersion',
      message: 'Expected a Notion API version in YYYY-MM-DD form.',
    })
  }
  if (
    manifest.dataSourceId !== undefined &&
    (typeof manifest.dataSourceId !== 'string' || !manifest.dataSourceId.trim())
  ) {
    issues.push({ path: 'dataSourceId', message: 'Expected a non-empty string.' })
  }
  const exportName = requireString(manifest, 'exportName', 'exportName')
  if (
    exportName &&
    (!typescriptIdentifier.test(exportName) || reservedBindings.has(exportName))
  ) {
    issues.push({
      path: 'exportName',
      message: 'Expected a non-reserved TypeScript binding identifier.',
    })
  }

  const usedKeys = new Map<string, string>()
  const registerKey = (key: string | null, path: string) => {
    if (!key) return
    if (!typescriptIdentifier.test(key)) {
      issues.push({ path, message: 'Expected a valid TypeScript property identifier.' })
      return
    }
    const previous = usedKeys.get(key)
    if (previous) {
      issues.push({ path, message: `Duplicates generated field ${key} from ${previous}.` })
    } else {
      usedKeys.set(key, path)
    }
  }

  const syncKey = record(manifest.syncKey)
  registerKey(requireString(syncKey, 'key', 'syncKey.key'), 'syncKey.key')
  requireString(syncKey, 'name', 'syncKey.name')
  if (
    syncKey?.propertyId !== undefined &&
    (typeof syncKey.propertyId !== 'string' || !syncKey.propertyId.trim())
  ) {
    issues.push({ path: 'syncKey.propertyId', message: 'Expected a non-empty string.' })
  }

  const metadata = record(manifest.metadata)
  for (const key of ['pageId', 'pageUrl', 'createdTime', 'lastEditedTime']) {
    registerKey(
      requireString(metadata, key, `metadata.${key}`),
      `metadata.${key}`,
    )
  }

  if (!Array.isArray(manifest.properties)) {
    issues.push({ path: 'properties', message: 'Expected an array.' })
    return issues
  }
  const propertyNames = new Map<string, number>()
  const propertyIds = new Map<string, number>()
  manifest.properties.forEach((value, index) => {
    const property = record(value)
    const base = `properties[${index}]`
    if (!property) {
      issues.push({ path: base, message: 'Expected a property object.' })
      return
    }
    registerKey(requireString(property, 'key', `${base}.key`), `${base}.key`)
    const name = requireString(property, 'name', `${base}.name`)
    requireString(property, 'type', `${base}.type`)
    if (name) {
      const previous = propertyNames.get(name)
      if (previous !== undefined) {
        issues.push({
          path: `${base}.name`,
          message: `Duplicates Notion property name from properties[${previous}].`,
        })
      } else propertyNames.set(name, index)
    }
    if (property.propertyId !== undefined) {
      if (typeof property.propertyId !== 'string' || !property.propertyId.trim()) {
        issues.push({ path: `${base}.propertyId`, message: 'Expected a non-empty string.' })
      } else {
        const previous = propertyIds.get(property.propertyId)
        if (previous !== undefined) {
          issues.push({
            path: `${base}.propertyId`,
            message: `Duplicates stable property ID from properties[${previous}].`,
          })
        } else propertyIds.set(property.propertyId, index)
      }
    }
    if (property.options !== undefined && !Array.isArray(property.options)) {
      issues.push({ path: `${base}.options`, message: 'Expected an array.' })
    }
    if (property.config !== undefined && !record(property.config)) {
      issues.push({ path: `${base}.config`, message: 'Expected an object.' })
    }
  })
  return issues
}

export function assertNotionSchemaManifest(
  value: unknown,
): asserts value is NotionSchemaManifest {
  const issues = validateNotionSchemaManifest(value)
  if (!issues.length) return
  throw new Error(
    `Invalid Notion schema manifest:\n${issues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join('\n')}`,
  )
}

export type NotionSchemaOperation =
  | {
      kind: 'add'
      field: NotionManifestProperty
      destructive: false
      supported: boolean
    }
  | {
      kind: 'rename'
      field: NotionManifestProperty
      propertyId: string
      from: string
      to: string
      destructive: false
      supported: true
    }
  | {
      kind: 'change_type'
      field: NotionManifestProperty
      propertyId: string
      from: NotionDataSourcePropertyType
      to: NotionDataSourcePropertyType
      destructive: true
      supported: boolean
    }
  | {
      kind: 'update_options'
      field: NotionManifestProperty
      propertyId: string
      added: Array<string>
      removed: Array<string>
      destructive: boolean
      supported: boolean
    }

const directlyManagedTypes = new Set<NotionDataSourcePropertyType>([
  'rich_text',
  'number',
  'select',
  'multi_select',
  'date',
  'people',
  'files',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
])

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      if (typeof record.plain_text === 'string') return record.plain_text
      const text = record.text
      return text && typeof text === 'object'
        ? String((text as Record<string, unknown>).content ?? '')
        : ''
    })
    .join('')
}

function parseOptions(config: Record<string, unknown>): Array<NotionSchemaOption> {
  if (!Array.isArray(config.options)) return []
  return config.options.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const option = value as Record<string, unknown>
    if (typeof option.name !== 'string') return []
    return [
      {
        name: option.name,
        ...(typeof option.id === 'string' ? { id: option.id } : {}),
        ...(typeof option.color === 'string' ? { color: option.color } : {}),
      },
    ]
  })
}

function isPropertyType(value: unknown): value is NotionDataSourcePropertyType {
  return typeof value === 'string' && value.length > 0
}

function identifier(value: string, fallback: string): string {
  const words = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[A-Za-z0-9]+/g)
  if (!words?.length) return fallback
  const [first, ...rest] = words
  const result =
    first!.toLowerCase() +
    rest.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('')
  return /^[A-Za-z_$]/.test(result) ? result : `field${result}`
}

function uniqueKey(preferred: string, used: Set<string>): string {
  let key = preferred
  let suffix = 2
  while (used.has(key)) {
    key = `${preferred}${suffix}`
    suffix += 1
  }
  used.add(key)
  return key
}

function propertyIdMatches(left: string, right: string): boolean {
  if (left === right) return true
  try {
    return decodeURIComponent(left) === decodeURIComponent(right)
  } catch {
    return false
  }
}

export async function inspectNotionDataSource(
  config: InspectNotionDataSourceConfig,
): Promise<NotionDataSourceSnapshot> {
  const fetcher = config.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('A fetch implementation is required.')
  const notionVersion = config.notionVersion ?? LATEST_NOTION_VERSION
  const baseUrl = (config.baseUrl ?? 'https://api.notion.com').replace(/\/$/, '')
  const dataSourceId = await resolveNotionDataSourceId({
    token: config.token,
    id: config.id,
    notionVersion,
    fetch: fetcher,
    baseUrl,
  })
  const response = await fetcher(
    `${baseUrl}/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': notionVersion,
        Accept: 'application/json',
      },
    },
  )
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >
  if (!response.ok) {
    throw new Error(
      typeof body.message === 'string'
        ? body.message
        : `Notion returned HTTP ${response.status}.`,
    )
  }

  const propertiesRecord =
    body.properties && typeof body.properties === 'object'
      ? (body.properties as Record<string, unknown>)
      : {}
  const properties: Array<NotionDataSourcePropertySnapshot> = []
  for (const [propertyName, value] of Object.entries(propertiesRecord)) {
    if (!value || typeof value !== 'object') continue
    const property = value as Record<string, unknown>
    if (typeof property.id !== 'string' || !isPropertyType(property.type)) {
      continue
    }
    const configValue = property[property.type]
    const propertyConfig =
      configValue && typeof configValue === 'object'
        ? (configValue as Record<string, unknown>)
        : {}
    const options =
      property.type === 'select' ||
      property.type === 'multi_select' ||
      property.type === 'status'
        ? parseOptions(propertyConfig)
        : undefined
    properties.push({
      id: property.id,
      name:
        typeof property.name === 'string' ? property.name : propertyName,
      type: property.type,
      config: propertyConfig,
      ...(options ? { options } : {}),
    })
  }

  return {
    notionVersion,
    dataSourceId,
    name: plainText(body.title) || null,
    properties,
  }
}

export function createNotionSchemaManifest(
  snapshot: NotionDataSourceSnapshot,
  options: {
    exportName?: string
    syncKeyName?: string
    existing?: NotionSchemaManifest
  } = {},
): NotionSchemaManifest {
  const existing = options.existing
  const syncKeyName = options.syncKeyName ?? existing?.syncKey.name ?? 'Client ID'
  const used = new Set<string>()
  const existingProperties = existing?.properties ?? []
  const findExisting = (property: NotionDataSourcePropertySnapshot) =>
    existingProperties.find(
      (field) =>
        (field.propertyId && propertyIdMatches(field.propertyId, property.id)) ||
        field.name === property.name ||
        (field.type === 'title' && property.type === 'title'),
    )
  const remoteSyncKey = snapshot.properties.find(
    (property) =>
      property.type === 'rich_text' &&
      ((existing?.syncKey.propertyId &&
        propertyIdMatches(existing.syncKey.propertyId, property.id)) ||
        property.name === syncKeyName),
  )

  const syncKey = {
    key: uniqueKey(existing?.syncKey.key ?? 'id', used),
    name: remoteSyncKey?.name ?? syncKeyName,
    ...(remoteSyncKey ? { propertyId: remoteSyncKey.id } : {}),
  }
  const remoteProperties = snapshot.properties.filter(
    (property) => property.id !== remoteSyncKey?.id,
  )
  const orderedRemoteProperties: Array<NotionDataSourcePropertySnapshot> = []
  const includedRemoteIds = new Set<string>()

  // Notion returns properties in an API-defined order. Once a developer has a
  // manifest, retain that order so pull/push does not create meaningless diffs
  // or reorder generated fields. Newly discovered remote fields are appended.
  for (const previous of existingProperties) {
    const remote = remoteProperties.find(
      (property) =>
        (previous.propertyId &&
          propertyIdMatches(previous.propertyId, property.id)) ||
        previous.name === property.name ||
        (previous.type === 'title' && property.type === 'title'),
    )
    if (!remote || includedRemoteIds.has(remote.id)) continue
    orderedRemoteProperties.push(remote)
    includedRemoteIds.add(remote.id)
  }
  for (const remote of remoteProperties) {
    if (includedRemoteIds.has(remote.id)) continue
    orderedRemoteProperties.push(remote)
    includedRemoteIds.add(remote.id)
  }

  const properties = orderedRemoteProperties
    .map((property, index): NotionManifestProperty => {
      const previous = findExisting(property)
      const preferredKey =
        previous?.key ??
        (property.type === 'title'
          ? 'title'
          : identifier(property.name, `field${index + 1}`))
      return {
        key: uniqueKey(preferredKey, used),
        propertyId: property.id,
        name: property.name,
        type: property.type,
        config: property.config,
        ...(property.options ? { options: property.options } : {}),
        ...(previous?.defaultValue !== undefined
          ? { defaultValue: previous.defaultValue }
          : {}),
      }
    })

  for (const previous of existingProperties) {
    const stillPresent = properties.some(
      (property) =>
        (property.propertyId &&
          previous.propertyId &&
          propertyIdMatches(property.propertyId, previous.propertyId)) ||
        property.name === previous.name,
    )
    if (stillPresent) continue
    const { propertyId: _removedPropertyId, ...localProperty } = previous
    properties.push({
      ...localProperty,
      key: uniqueKey(previous.key, used),
    })
  }

  const metadataPreferences = existing?.metadata ?? {
    pageId: 'notionPageId',
    pageUrl: 'notionUrl',
    createdTime: 'createdAt',
    lastEditedTime: 'updatedAt',
  }
  const metadata = {
    pageId: uniqueKey(metadataPreferences.pageId, used),
    pageUrl: uniqueKey(metadataPreferences.pageUrl, used),
    createdTime: uniqueKey(metadataPreferences.createdTime, used),
    lastEditedTime: uniqueKey(metadataPreferences.lastEditedTime, used),
  }

  return {
    version: 1,
    notionVersion: snapshot.notionVersion,
    dataSourceId: snapshot.dataSourceId,
    exportName: options.exportName ?? existing?.exportName ?? 'notionDataSourceSchema',
    syncKey,
    metadata,
    properties,
  }
}

function quote(value: unknown): string {
  return JSON.stringify(value)
}

function referenceSource(field: {
  name: string
  propertyId?: string
}): string {
  return field.propertyId
    ? `{ name: ${quote(field.name)}, id: ${quote(field.propertyId)} }`
    : quote(field.name)
}

function optionsSource(options: Array<NotionSchemaOption> | undefined): string {
  return `[${(options ?? []).map((option) => quote(option.name)).join(', ')}] as const`
}

function propertySource(field: NotionManifestProperty): string {
  const property = referenceSource(field)
  const defaultValue = field.defaultValue
  switch (field.type) {
    case 'title':
      return `notion.title(${property})`
    case 'rich_text':
      return `notion.richText(${property}${typeof defaultValue === 'string' ? `, ${quote(defaultValue)}` : ''})`
    case 'checkbox':
      return `notion.checkbox(${property}${typeof defaultValue === 'boolean' ? `, ${defaultValue}` : ''})`
    case 'number':
      return `notion.number(${property})`
    case 'select':
      return `notion.select(${property}, ${optionsSource(field.options)}${typeof defaultValue === 'string' || defaultValue === null ? `, ${quote(defaultValue)}` : ''})`
    case 'multi_select':
      return `notion.multiSelect(${property}, ${optionsSource(field.options)})`
    case 'date':
      return `notion.date(${property})`
    case 'url':
      return `notion.url(${property})`
    case 'email':
      return `notion.email(${property})`
    case 'phone_number':
      return `notion.phoneNumber(${property})`
    case 'status':
      return `notion.status(${property}, ${optionsSource(field.options)}${typeof defaultValue === 'string' || defaultValue === null ? `, ${quote(defaultValue)}` : ''})`
    case 'people':
      return `notion.people(${property})`
    case 'files':
      return `notion.files(${property})`
    case 'formula':
      return `notion.formula(${property})`
    case 'relation':
      return `notion.relation(${property})`
    case 'rollup':
      return `notion.rollup(${property})`
    case 'created_by':
      return `notion.createdBy(${property})`
    case 'created_time':
      return `notion.createdTime(${property})`
    case 'last_edited_by':
      return `notion.lastEditedBy(${property})`
    case 'last_edited_time':
      return `notion.lastEditedTime(${property})`
    case 'unique_id':
      return `notion.uniqueId(${property})`
    default:
      return `notion.raw(${property}, ${quote(field.type)})`
  }
}

export function generateNotionSchemaSource(
  manifest: NotionSchemaManifest,
  options: { packageName?: string } = {},
): string {
  assertNotionSchemaManifest(manifest)
  const packageName = options.packageName ?? 'tanstack-db-notion-adapter'
  const titleCount = manifest.properties.filter(
    (property) => property.type === 'title',
  ).length
  if (titleCount !== 1) {
    throw new Error(
      `A generated adapter schema needs exactly one title property; found ${titleCount}.`,
    )
  }

  const lines = [
    '// Generated by tanstack-db-notion-adapter. Edit the manifest, then regenerate.',
    `import { notion, notionSchema, type InferNotionInput, type InferNotionOutput } from ${quote(packageName)}`,
    '',
    `export const ${manifest.exportName} = notionSchema({`,
    `  ${manifest.syncKey.key}: notion.id(${referenceSource(manifest.syncKey)}),`,
  ]
  for (const property of manifest.properties) {
    lines.push(`  ${property.key}: ${propertySource(property)},`)
  }
  lines.push(
    `  ${manifest.metadata.createdTime}: notion.createdTime(),`,
    `  ${manifest.metadata.lastEditedTime}: notion.lastEditedTime(),`,
    `  ${manifest.metadata.pageId}: notion.pageId(),`,
    `  ${manifest.metadata.pageUrl}: notion.pageUrl(),`,
    '})',
    '',
    `export type ${manifest.exportName[0]!.toUpperCase()}${manifest.exportName.slice(1)}Input = InferNotionInput<`,
    `  typeof ${manifest.exportName}.fields`,
    '>',
    '',
    `export type ${manifest.exportName[0]!.toUpperCase()}${manifest.exportName.slice(1)}Row = InferNotionOutput<`,
    `  typeof ${manifest.exportName}.fields`,
    '>',
    '',
  )
  return lines.join('\n')
}

function manifestFields(
  manifest: NotionSchemaManifest,
): Array<NotionManifestProperty> {
  return [
    {
      key: manifest.syncKey.key,
      name: manifest.syncKey.name,
      type: 'rich_text',
      ...(manifest.syncKey.propertyId
        ? { propertyId: manifest.syncKey.propertyId }
        : {}),
    },
    ...manifest.properties,
  ]
}

function findRemoteProperty(
  field: NotionManifestProperty,
  snapshot: NotionDataSourceSnapshot,
): NotionDataSourcePropertySnapshot | undefined {
  if (field.propertyId) {
    const byId = snapshot.properties.find((property) =>
      propertyIdMatches(field.propertyId!, property.id),
    )
    if (byId) return byId
  }
  const byName = snapshot.properties.find(
    (property) => property.name === field.name,
  )
  if (byName) return byName
  if (field.type === 'title') {
    return snapshot.properties.find((property) => property.type === 'title')
  }
  return undefined
}

function canManage(field: NotionManifestProperty): boolean {
  return directlyManagedTypes.has(field.type) || field.type === 'title'
}

export function diffNotionSchema(
  manifest: NotionSchemaManifest,
  snapshot: NotionDataSourceSnapshot,
): Array<NotionSchemaOperation> {
  const operations: Array<NotionSchemaOperation> = []
  for (const field of manifestFields(manifest)) {
    const remote = findRemoteProperty(field, snapshot)
    if (!remote) {
      operations.push({
        kind: 'add',
        field,
        destructive: false,
        supported: canManage(field) && field.type !== 'title',
      })
      continue
    }
    if (remote.name !== field.name) {
      operations.push({
        kind: 'rename',
        field,
        propertyId: remote.id,
        from: remote.name,
        to: field.name,
        destructive: false,
        supported: true,
      })
    }
    if (remote.type !== field.type) {
      operations.push({
        kind: 'change_type',
        field,
        propertyId: remote.id,
        from: remote.type,
        to: field.type,
        destructive: true,
        supported: canManage(field) && field.type !== 'title',
      })
      continue
    }
    if (
      field.type === 'select' ||
      field.type === 'multi_select' ||
      field.type === 'status'
    ) {
      const desired = new Set((field.options ?? []).map((option) => option.name))
      const actual = new Set((remote.options ?? []).map((option) => option.name))
      const added = [...desired].filter((name) => !actual.has(name))
      const removed = [...actual].filter((name) => !desired.has(name))
      if (added.length || removed.length) {
        operations.push({
          kind: 'update_options',
          field,
          propertyId: remote.id,
          added,
          removed,
          destructive: removed.length > 0,
          supported: field.type !== 'status',
        })
      }
    }
  }
  return operations
}

function schemaConfig(field: NotionManifestProperty): Record<string, unknown> {
  switch (field.type) {
    case 'number':
      return field.config ?? { format: 'number' }
    case 'select':
    case 'multi_select':
      return {
        options: (field.options ?? []).map((option) => ({
          name: option.name,
          ...(option.color ? { color: option.color } : {}),
        })),
      }
    default:
      return field.config ?? {}
  }
}

function updateOptionsConfig(
  field: NotionManifestProperty,
  remote: NotionDataSourcePropertySnapshot,
): Record<string, unknown> {
  const remoteByName = new Map(
    (remote.options ?? []).map((option) => [option.name, option]),
  )
  return {
    options: (field.options ?? []).map((option) => {
      const existing = remoteByName.get(option.name)
      return existing?.id
        ? { id: existing.id }
        : {
            name: option.name,
            ...(option.color ? { color: option.color } : {}),
          }
    }),
  }
}

export async function pushNotionSchema(
  config: InspectNotionDataSourceConfig & {
    manifest: NotionSchemaManifest
    snapshot?: NotionDataSourceSnapshot
    acceptDataLoss?: boolean
    /** @deprecated Use acceptDataLoss. */
    allowDestructive?: boolean
  },
): Promise<NotionDataSourceSnapshot> {
  const snapshot = config.snapshot ?? (await inspectNotionDataSource(config))
  const operations = diffNotionSchema(config.manifest, snapshot)
  const unsupported = operations.filter((operation) => !operation.supported)
  if (unsupported.length) {
    throw new Error(
      `Notion cannot safely apply ${unsupported.map((operation) => `${operation.kind} ${operation.field.name}`).join(', ')} through this workflow. Update those properties in Notion, then pull again.`,
    )
  }
  const destructive = operations.filter((operation) => operation.destructive)
  if (
    destructive.length &&
    !config.acceptDataLoss &&
    !config.allowDestructive
  ) {
    throw new Error(
      `The schema diff contains destructive changes (${destructive.map((operation) => `${operation.kind} ${operation.field.name}`).join(', ')}). Explicitly allow destructive changes after reviewing the diff.`,
    )
  }
  if (!operations.length) return snapshot

  const properties: Record<string, unknown> = {}
  for (const operation of operations) {
    if (operation.kind === 'add') {
      properties[operation.field.name] = {
        [operation.field.type]: schemaConfig(operation.field),
      }
    } else if (operation.kind === 'rename') {
      properties[operation.propertyId] = { name: operation.to }
    } else if (operation.kind === 'change_type') {
      properties[operation.propertyId] = {
        [operation.to]: schemaConfig(operation.field),
      }
    } else {
      const remote = snapshot.properties.find((property) =>
        propertyIdMatches(property.id, operation.propertyId),
      )!
      properties[operation.propertyId] = {
        [operation.field.type]: updateOptionsConfig(operation.field, remote),
      }
    }
  }

  const fetcher = config.fetch ?? globalThis.fetch
  if (!fetcher) throw new Error('A fetch implementation is required.')
  const baseUrl = (config.baseUrl ?? 'https://api.notion.com').replace(/\/$/, '')
  const response = await fetcher(
    `${baseUrl}/v1/data_sources/${encodeURIComponent(snapshot.dataSourceId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': config.notionVersion ?? LATEST_NOTION_VERSION,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    },
  )
  const body = (await response.json().catch(() => ({}))) as {
    message?: string
  }
  if (!response.ok) {
    throw new Error(body.message ?? `Notion returned HTTP ${response.status}.`)
  }
  return inspectNotionDataSource({
    token: config.token,
    id: snapshot.dataSourceId,
    fetch: fetcher,
    baseUrl,
    ...(config.notionVersion ? { notionVersion: config.notionVersion } : {}),
  })
}

export function formatNotionSchemaDiff(
  operations: Array<NotionSchemaOperation>,
): string {
  if (!operations.length) return 'Schema is in sync.'
  return operations
    .map((operation) => {
      const marker = operation.supported
        ? operation.destructive
          ? '!'
          : '+'
        : 'x'
      switch (operation.kind) {
        case 'add':
          return `${marker} add ${operation.field.name} (${operation.field.type})`
        case 'rename':
          return `${marker} rename ${operation.from} -> ${operation.to}`
        case 'change_type':
          return `${marker} change ${operation.field.name}: ${operation.from} -> ${operation.to}`
        case 'update_options':
          return `${marker} update ${operation.field.name} options (add: ${operation.added.join(', ') || 'none'}; remove: ${operation.removed.join(', ') || 'none'})`
      }
    })
    .join('\n')
}
