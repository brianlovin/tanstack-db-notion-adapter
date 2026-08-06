---
name: tanstack-db-notion
description: Connect, generate, evolve, and troubleshoot type-safe offline TanStack DB collections backed by Notion data sources. Use when adding tanstack-db-notion-adapter to an app, introspecting an existing Notion schema, changing a checked-in notion.schema.json manifest, protecting a sync endpoint, resolving schema drift or multi-data-source setup, or adding lazy Notion page-content editing.
---

# TanStack DB Notion

Instrument the adapter without exposing credentials or weakening its offline
acknowledgement guarantees.

## Start with evidence

1. Inspect `package.json`, the installed adapter version, repository
   instructions, and any `notion.schema.json` before editing.
2. Run the package CLI's read-only doctor when available:

   ```sh
   npx tanstack-db-notion doctor \
     --manifest notion.schema.json --env .env
   ```

   The skill's `scripts/doctor.mjs` is a fallback for older installed releases.

3. Read [references/property-support.md](references/property-support.md) when
   mapping or changing fields. Read
   [references/troubleshooting.md](references/troubleshooting.md) for an error
   or stalled sync. Read
   [references/framework-recipes.md](references/framework-recipes.md) when
   mounting a new endpoint.

Do not print, copy into source, or pass a Notion token to browser code. An env
file is a connection mechanism, not a schema source.

## Choose the schema workflow

For an existing data source, introspect it:

```sh
npx tanstack-db-notion init \
  --env .env \
  --id "https://app.notion.com/p/workspace/..." \
  --manifest notion.schema.json \
  --out src/notion.generated.ts \
  --name projectSchema
```

For a code-first project, create or edit the checked-in manifest and generate:

```sh
npx tanstack-db-notion generate \
  --manifest notion.schema.json \
  --out src/notion.generated.ts
```

Treat the manifest as authored source and the generated TypeScript file as
output. Never hand-edit generated descriptors. Preserve Notion property IDs;
they keep a field stable when its display name changes.

Accept an exact data source ID, database ID, or pasted Notion database URL. A
database is safe only when it resolves to one data source. If Notion returns
multiple sources, list the choices and ask the user to select one; never guess.
Use `resolveNotionDataSourceId()` for the same resolution in server setup.

## Evolve safely

1. Edit or pull the manifest.
2. Regenerate types and typecheck the app.
3. Preview remote changes:

   ```sh
   npx tanstack-db-notion push --dry-run \
     --env .env --manifest notion.schema.json
   ```

4. Explain the exact additions, renames, removals, or type changes.
   Explicitly call out when push will add the visible `Client ID` rich-text
   property used as the stable offline sync key.
5. Apply a push only after the dry run is clean. Obtain explicit user approval
   before any command that accepts data loss.
6. Run `check` in CI to detect drift.

If a field is raw, lossy, truncated, or unsupported, keep that limitation
visible in types and documentation. Do not silently omit it.

## Mount the trust boundary

Keep `createNotionSyncHandler` in a server-only module. Provide `authorize` and
verify the caller may access the configured data source. The
`dangerouslyAllowUnauthenticated` escape hatch is only for a localhost example.
Provide a durable `idempotencyStore` shared by all production handler
instances. `dangerouslyAllowEphemeralIdempotency` is also localhost-only.
Share a `NotionRateLimiter` and `NotionInvalidationStore` across handlers that
use the same connection. The memory implementations coordinate one process
only; serverless or horizontally scaled apps need distributed backends.

Use the same generated schema on both sides:

```ts
const handleItems = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: projectSchema,
  authorize: authorizeRequest,
  idempotencyStore: durableIdempotencyStore,
})

const items = createCollection(
  notionCollectionOptions({
    id: 'notion-items',
    endpoint: '/api/items',
    schema: projectSchema,
  }),
)
```

Mount GET and POST at that same endpoint; the handler dispatches schema,
version, and content operations with its query string. If the collection can
load before browser authentication finishes, set `autoStart: false`, then call
`items.utils.resumeSync()` after session restoration and `pauseSync()` before
logout. Do not let module evaluation race the login gate.

Do not report a TanStack mutation as persisted until its outbox write is
durable. Preserve FIFO ordering, overlay pending writes on remote snapshots,
and expose retry/discard rather than deleting a poison entry automatically.
Treat `property_conflict` as a recoverable field-level conflict. Do not replace
the remote row with the full local row.

For a large history or feed that users do not edit, prefer a read-only handler
plus `readOnly: true` and `syncMode: 'progressive'` on the collection. Use
`notion.pageId()` as the collection key when the existing source has no stable
client-ID property. Drive infinite scrolling with `collection.utils.loadMore()`
and observe `getPaginationState()`. Do not simulate progressive writes or clear
cached rows when offline: loaded pages and their cursor are one checkpoint.

## Add page bodies only when needed

Keep data-source properties in the main collection. For note/document bodies,
enable `pageContent: true` on the protected handler and use
`createNotionPageContentClient` lazily for the selected page. Save each editor
draft locally immediately; debounce only the remote flush. Keep local and
remote bodies on conflict and require explicit data-loss acceptance before an
overwrite.

For authenticated startup, configure the content client with
`autoStart: false`, then resume and pause it with the main collection.

Pass the TanStack DB `collection` to `createNotionPageContentClient`. For a new
row, choose the client ID, persist `content.createDraft(id)` first, then call
`collection.insert({ id, ... })`. The client observes all rows and attaches the
Notion page ID after an offline insert syncs, even when that row is not selected.
For an existing row, call `content.attachPage(row.id, row.notionPageId)` on
demand. Use `content.flush(id)` as save-now or explicit retry. If the collection
is omitted, the host must attach every pending draft itself.

Do not eagerly fetch every page body. Refuse lossy replacement when Notion
reports truncation or unknown blocks.

## Verify before handoff

Run the repository-equivalent commands for:

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Also exercise offline edit → reload → reconnect for adapter changes. For schema
changes, run generation plus a dry-run/check. For endpoint changes, test
unauthorized, malformed, oversized, timed-out, and sanitized failures. Report
unsupported property types, remaining drift, local-memory fallback, ambiguous
data sources, and any skipped live Notion test.

For a production-shaped personal app, inspect `apps/todo` in the adapter
repository. It demonstrates auth, same-origin writes, durable SQLite
idempotency, a PWA shell, virtualized lists, offline session policy, page-body
notes, and visible outbox recovery. Do not copy its single-host stores into a
distributed deployment without replacing them.
