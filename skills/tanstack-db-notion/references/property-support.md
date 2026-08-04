# Property support

Consult the package's `docs/PROPERTY_SUPPORT.md` when working inside the
adapter repository. For an installed package, use this compact routing table.

## First-class writable

- `title`, `rich_text` → string, or `NotionRichTextItem[]` with the rich-item
  codecs to retain annotations, mentions, links, and equations
- `checkbox` → boolean
- `number` → number or null
- `select`, `status` → literal option union or null
- `multi_select` → literal option array
- `date` → ISO start string or null, or `NotionDateValue` with `dateRange`
- `url`, `email`, `phone_number` → string or null
- `people` → typed user references; writes use IDs
- `relation` → typed page-ID references

## First-class read-only

- `created_time`, `last_edited_time`, `created_by`, `last_edited_by`
- typed files, formula results, rollups, and unique IDs
- synthetic Notion page ID and page URL

## Retained as read-only raw values

Place, wiki verification, and future unknown types remain visible as `unknown`.
Never omit them silently.

## Completeness traps

Standard page responses can truncate title, rich text, people, and relation
values after 25 references. Add those field keys to the server handler's
`completeProperties` option to use the paginated page-property endpoint.
Notion-hosted file URLs expire and are not durable offline media.

Generated `*Input` types omit read-only fields; generated `*Row` types include
them. Formulas, relations, rollups, descriptions, and number formats are not all
managed by schema push—make unsupported configuration changes in Notion and
pull the manifest.

Status values are writable at runtime, but Notion does not allow status schema
updates through the API. Make those schema changes in Notion, then pull.
