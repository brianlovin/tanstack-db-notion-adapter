# Notion property support

This matrix is the runtime contract for the current release. Generated insert
types omit read-only fields; generated row types include them. A property marked
**raw** is retained as read-only `unknown` rather than silently disappearing.

| Notion property | Read | Write | Representation | Important boundary |
| --- | --- | --- | --- | --- |
| Title | Yes | Yes | `string`, or `NotionRichTextItem[]` with `notion.titleItems` | String mode intentionally flattens formatting. |
| Rich text | Yes | Yes | `string`, or `NotionRichTextItem[]` with `notion.richTextItems` | Rich mode preserves annotations, mentions, links, and equations. |
| Checkbox | Yes | Yes | `boolean` | — |
| Number | Yes | Yes | `number \| null` | Number format is not currently managed by schema push. |
| Select | Yes | Yes | option-name literal union or `null` | Option colors are retained in the manifest; runtime values use names. |
| Multi-select | Yes | Yes | array of option-name literals | Option colors are retained in the manifest; runtime values use names. |
| Status | Yes | Yes | option-name literal union or `null` | Notion does not permit status schema updates through this API. |
| Date | Yes | Yes | ISO start string or `null`, or `NotionDateValue` with `notion.dateRange` | Range mode preserves `end` and `timeZone`. |
| URL | Yes | Yes | `string \| null` | — |
| Email | Yes | Yes | `string \| null` | — |
| Phone number | Yes | Yes | `string \| null` | — |
| People | Yes | Yes | `NotionUserReference[]` | Writes use user IDs; configure `completeProperties` for more than 25 people. |
| Relation | Yes | Yes | `{ id: string }[]` | Target rows are not inferred; configure `completeProperties` for more than 25 relations. |
| Files | Yes | No | `NotionFileReference[]` | Notion-hosted URLs expire and are not durable offline media. |
| Formula | Yes | No | discriminated `NotionFormulaValue \| null` | Formula configuration is not managed by schema push. |
| Rollup | Yes | No | discriminated `NotionRollupValue \| null` | Rollup arrays retain nested values as `unknown`; configuration is unmanaged. |
| Created time | Yes | No | ISO timestamp | Read-only and omitted from insert types. |
| Last edited time | Yes | No | ISO timestamp | Read-only and omitted from insert types. |
| Created by | Yes | No | `NotionUserReference \| null` | Read-only. |
| Last edited by | Yes | No | `NotionUserReference \| null` | Read-only. |
| Unique ID | Yes | No | `{ prefix: string \| null; number: number \| null } \| null` | Read-only. |
| Place | Raw | No | `unknown` | Awaiting stable fixtures and a first-class representation. |
| Verification | Raw | No | `unknown` | Wiki-only behavior still needs live fixtures. |
| Future unknown type | Raw | No | `unknown` | Introspection keeps the field visible and generation stays deterministic. |
| Synthetic client ID | Yes | Yes | `string` in a rich-text property | Provides a stable offline key and insert retry identity. |
| Synthetic Notion page ID | Yes | No | `string \| null` | Page metadata, not a data-source property. |
| Synthetic Notion URL | Yes | No | `string \| null` | Page metadata, not a data-source property. |

## Complete property reads

A normal Notion page response can truncate title, rich text, people, and
relation values after 25 references. Opt specific fields into the paginated
page-property endpoint on the server:

```ts
createNotionSyncHandler({
  // ...
  completeProperties: ['authors', 'relatedProjects'],
})
```

Each opted-in field adds requests for every returned page, so use it only where
the value can exceed Notion's inline limit. The shared rate limiter also covers
these requests.

## Schema identity and managed drift

Notion display names can change. Generated descriptors store stable property
IDs, and runtime parsing, writing, filters, and sorts prefer those IDs. The
schema workflow currently manages additions, renames, type changes, and
select/multi-select option names and colors. It intentionally does not rewrite
status configuration, formulas, relations, rollups, descriptions, or number
formatting. Make those changes in Notion and run `pull`.

## Page contents are separate

Database properties and the blocks inside each page are different Notion APIs.
Set `pageContent: true` on the protected server handler and use
`createNotionPageContentClient` only for pages whose content the user opens.
Enhanced Markdown replacement is refused when Notion reports an incomplete or
lossy representation.
