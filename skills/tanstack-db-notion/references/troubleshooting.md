# Troubleshooting

## `not_configured`

Confirm the server process loaded `NOTION_PAT` (or the legacy `NOTION_TOKEN`)
and the generated schema contains a data source ID. A hand-written schema must
instead pass `dataSourceId` to the handler. Do not expose or log tokens. Restart
the server after changing env files.

## Ambiguous database

The database contains multiple data sources. Retrieve/list their names and IDs,
then set the exact data source ID chosen by the user.

## Sync returns 401 during application startup

The collection loaded before the browser session. Configure `autoStart: false`,
restore or create the session, then call `collection.utils.resumeSync()`. Call
`pauseSync()` before logout or an account switch. Cached rows and pending
mutations remain durable while automatic requests are paused.

## `schema_mismatch`

Run `pull` to inspect live state or `push --dry-run` to compare desired state.
Check stable property IDs before treating a rename as a missing/additional
field. Edit the manifest, not generated TypeScript.

## Pending mutation does not clear

Inspect `getPendingMutations()`. Use its attempt and `lastError` metadata. Fix
auth/schema/network state, then call `retryPendingMutation(id)`. Discard only
with `acceptDataLoss: true`, while online, and after the user approves losing
that acknowledged edit.

## `page_content_conflict`

Keep the local draft and retrieve the remote body. Let the user accept the
remote copy or explicitly overwrite it. Do not auto-merge arbitrary Markdown.

## Offline row synced but its page body is empty

Pass the row collection to `createNotionPageContentClient({ collection })` and
create the content draft before inserting the row. The content client then
observes page-ID assignment for every row and flushes unselected drafts. If the
collection is omitted, call `attachPage` for every draft whose row receives a
Notion page ID; attaching only the selected row can strand content indefinitely.

## `property_conflict`

Inspect `lastError.conflicts` for each field's base, local, and remote value.
Keep the pending mutation until the user chooses a value, then issue a new edit
based on refreshed remote state or explicitly discard the old mutation with
`acceptDataLoss: true`.

## Persisted state quarantined

Use `getQuarantinedState()` to inspect metadata and preserve the original value
for support or a migration. Never silently clear it. Only call
`discardQuarantinedState({ acceptDataLoss: true })` after the user understands
that unreadable cached rows or acknowledged mutations may be lost.

## Idempotency store required

Configure a durable shared store on `createNotionSyncHandler`. The store must
serialize concurrent keys and persist successful results across restarts. The
ephemeral escape hatch is not safe for serverless or multi-process production.

## `page_content_incomplete`

Notion reported truncation, inaccessible blocks, or an unsupported Markdown
representation. Keep the editor read-only and use the block API for a targeted
implementation; never replace the incomplete string as the whole page.

## Storage unavailable

IndexedDB and localStorage are unavailable or failed. The default browser
storage correctly rejects durable acknowledgement. Do not enable memory
fallback without explaining that reload can lose edits.
