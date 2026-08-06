type SchemaPushCapability = 'direct' | 'rename-only' | 'manual'

interface NotionPropertyCapability {
  schemaBuilder: string | null
  schemaPush: SchemaPushCapability
  hasOptions: boolean
}

export const NOTION_PROPERTY_CAPABILITIES = {
  title: { schemaBuilder: 'title', schemaPush: 'rename-only', hasOptions: false },
  rich_text: { schemaBuilder: 'richText', schemaPush: 'direct', hasOptions: false },
  number: { schemaBuilder: 'number', schemaPush: 'direct', hasOptions: false },
  select: { schemaBuilder: 'select', schemaPush: 'direct', hasOptions: true },
  multi_select: {
    schemaBuilder: 'multiSelect',
    schemaPush: 'direct',
    hasOptions: true,
  },
  status: { schemaBuilder: 'status', schemaPush: 'manual', hasOptions: true },
  date: { schemaBuilder: 'date', schemaPush: 'direct', hasOptions: false },
  people: { schemaBuilder: 'people', schemaPush: 'direct', hasOptions: false },
  files: { schemaBuilder: 'files', schemaPush: 'direct', hasOptions: false },
  checkbox: { schemaBuilder: 'checkbox', schemaPush: 'direct', hasOptions: false },
  url: { schemaBuilder: 'url', schemaPush: 'direct', hasOptions: false },
  email: { schemaBuilder: 'email', schemaPush: 'direct', hasOptions: false },
  phone_number: {
    schemaBuilder: 'phoneNumber',
    schemaPush: 'direct',
    hasOptions: false,
  },
  formula: { schemaBuilder: 'formula', schemaPush: 'manual', hasOptions: false },
  relation: { schemaBuilder: 'relation', schemaPush: 'manual', hasOptions: false },
  rollup: { schemaBuilder: 'rollup', schemaPush: 'manual', hasOptions: false },
  created_time: {
    schemaBuilder: 'createdTime',
    schemaPush: 'direct',
    hasOptions: false,
  },
  created_by: {
    schemaBuilder: 'createdBy',
    schemaPush: 'direct',
    hasOptions: false,
  },
  last_edited_time: {
    schemaBuilder: 'lastEditedTime',
    schemaPush: 'direct',
    hasOptions: false,
  },
  last_edited_by: {
    schemaBuilder: 'lastEditedBy',
    schemaPush: 'direct',
    hasOptions: false,
  },
  unique_id: {
    schemaBuilder: 'uniqueId',
    schemaPush: 'manual',
    hasOptions: false,
  },
  place: { schemaBuilder: null, schemaPush: 'manual', hasOptions: false },
} as const satisfies Record<string, NotionPropertyCapability>

export type KnownNotionPropertyType = keyof typeof NOTION_PROPERTY_CAPABILITIES

export function notionPropertyCapability(
  type: string,
): NotionPropertyCapability | undefined {
  return Object.hasOwn(NOTION_PROPERTY_CAPABILITIES, type)
    ? NOTION_PROPERTY_CAPABILITIES[type as KnownNotionPropertyType]
    : undefined
}
