# TanStack DB Notion adapter

An offline-first, end-to-end typed TanStack DB collection backed by a Notion data source.

This repository contains a publishable adapter, focused Todo/Notes/Reliability
examples, and Daylight: a production-oriented standalone task application. The
browser renders and mutates an in-memory TanStack DB collection immediately,
persists rows and pending writes in IndexedDB, and reconciles them with Notion
through a server-only handler.

> Status: release candidate for authenticated personal and small-team mutable
> applications. Core no-data-loss invariants, conflict handling, schema tooling,
> page content, and a real-Notion offline task journey are tested. Distributed
> deployment and cross-browser gates remain; review
> [Current boundaries](#current-boundaries) before using production data.

## What the API feels like

Define the Notion mapping once in code:

```ts
import { notion, notionSchema } from 'tanstack-db-notion-adapter'

export const todoSchema = notionSchema({
  id: notion.id('Client ID'),
  title: notion.title('Name'),
  completed: notion.checkbox('Done'),
  priority: notion.select(
    'Priority',
    ['Low', 'Medium', 'High'] as const,
    'Medium',
  ),
  dueDate: notion.date('Due'),
  createdAt: notion.createdTime(),
  updatedAt: notion.lastEditedTime(),
  notionPageId: notion.pageId(),
  notionUrl: notion.pageUrl(),
})
```

Use it directly in a TanStack DB collection:

```ts
import { BTreeIndex, createCollection } from '@tanstack/react-db'
import { notionCollectionOptions } from 'tanstack-db-notion-adapter'

export const todos = createCollection(
  notionCollectionOptions({
    id: 'notion-todos',
    endpoint: '/api/todos',
    schema: todoSchema,
    autoIndex: 'eager',
    defaultIndexType: BTreeIndex,
  }),
)

// Only `title` is required. The schema supplies a stable client ID, defaults,
// local timestamps, and nullable Notion metadata.
todos.insert({ title: 'Ship the adapter' })

todos.update(id, (draft) => {
  draft.completed = true
  draft.priority = 'High' // autocomplete: Low | Medium | High | null
})
```

Mount the same schema in a server endpoint. The Notion token never enters the browser bundle:

```ts
import { createNotionSyncHandler } from 'tanstack-db-notion-adapter/server'
import { durableIdempotencyStore } from './infrastructure/idempotency'

export const handleTodos = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: todoSchema,
  authorize: async (request) => Boolean(await getUserFromSession(request)),
  idempotencyStore: durableIdempotencyStore,
})
```

`createNotionSyncHandler` accepts a Web `Request` and returns a Web `Response`, so it can be adapted to Hono, TanStack Start, Next.js, Cloudflare Workers, Bun, or a standard Node server.
An authorization decision is required because the endpoint can read and mutate
everything the configured token can access. Local-only examples opt out
explicitly with `dangerouslyAllowUnauthenticated: true`.
Production handlers must also provide a durable `idempotencyStore` shared by
every server instance. It serializes a key, fingerprints its payload, and
persists successful JSON results. Local examples opt into the process-only
implementation with `dangerouslyAllowEphemeralIdempotency: true`.
See [`docs/idempotency-store.md`](docs/idempotency-store.md) for the exact
backend contract and implementation guidance.

## Run the focused Todo example

Requirements: Node 20.19 or newer and a Notion personal access token with the **Notion API** capability. A PAT acts with its creator's existing workspace and page permissions, so the database does not need to be separately shared with a bot connection.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a blank Notion database. The checked-in manifest describes the
   desired Todo properties:

   | Property | Notion type | Values |
   | --- | --- | --- |
   | `Name` | Title | — |
   | `Client ID` | Text | — |
   | `Done` | Checkbox | — |
   | `Priority` | Select | `Low`, `Medium`, `High` |
   | `Due` | Date | — |

   Created and edited timestamps come from the page metadata, so they do not
   require extra Notion columns.

3. Copy an ID from Notion. You can use **Manage data sources → Copy data source ID**, or use the database/container ID when the database has exactly one data source. The example resolves a single-source database ID automatically.

4. Configure the server:

   ```sh
   cp examples/todos/.env.example examples/todos/.env
   ```

   Then set `NOTION_PAT` and either `NOTION_DATA_SOURCE_ID` or `NOTION_DATABASE_ID` in that file. `NOTION_TOKEN` remains supported as a backwards-compatible alias. Never commit the token.

5. Preview the schema changes without modifying Notion:

   ```sh
   npm run schema:push -- --dry-run
   ```

   On a blank database this shows four additive columns: `Client ID`, `Done`,
   `Priority`, and `Due`. Apply those reviewed changes with:

   ```sh
   npm run schema:push
   ```

   The push updates the Notion data source, pulls the stable property IDs into
   the manifest, and regenerates the typed TypeScript schema.

6. Start the API and Vite app:

   ```sh
   npm run dev
   ```

   Open [http://localhost:5173](http://localhost:5173). Use browser devtools to go offline, make edits, reload the page, then reconnect. The queued edits remain visible and synchronize when the connection returns.

## Run the Notes proof of concept

The second example validates a different shape of application: structured note
metadata is a normal TanStack DB collection, while each selected page body is
loaded lazily through Notion's enhanced-markdown API. Editor drafts are saved to
IndexedDB on every change, but remote writes are coalesced and flushed after 750
ms of idle time, on blur, on page switch, or explicitly.

Use a separate blank Notion data source, then:

```sh
cp examples/notes/.env.example examples/notes/.env
# Set the PAT and data source/database ID in examples/notes/.env
npm run schema:notes:push -- --dry-run
npm run schema:notes:push
npm run dev:notes
```

Open [http://localhost:5174](http://localhost:5174). A brand-new offline note
keeps its body under the stable client ID; when the row reaches Notion and gets
a page ID, the content client attaches and flushes the draft. If the page body
changed in Notion after it was loaded, the app keeps both versions and asks
which to retain instead of overwriting silently.

## Run the standalone Daylight app

[`apps/todo`](apps/todo) is the production acceptance app: a Vite+ PWA with
virtualized lists, Inbox/Today/Upcoming/Anytime/Someday/Logbook views, keyboard
quick entry, editable page-body notes, password-gated server access, a durable
SQLite idempotency ledger, webhook invalidation, and reload-safe offline edits.
It connects to a real Todo source rather than a mock transport.

See the [Daylight setup and deployment guide](apps/todo/README.md). The app is
the clearest reference for a private, high-interaction application—the adapter's
primary target—while the progressive listening-history recipe below demonstrates
the more limited read-only archive mode.

## Schema workflow

Notion display names are mutable, while property IDs remain stable when a
column is renamed. The adapter therefore keeps a checked-in
`notion.schema.json` manifest and generates TypeScript descriptors containing
those property IDs. Runtime reads, writes, validation, and query projections
prefer IDs and only fall back to names before the first push.

For an existing data source, introspect it and generate a typed schema:

```sh
npx tanstack-db-notion init \
  --env .env \
  --manifest notion.schema.json \
  --out src/notion.generated.ts \
  --name projectSchema
```

The generated schema includes literal unions for select and status options,
typed writable people and relation fields, typed read-only files/formulas/
rollups/users/unique IDs, and raw read-only fields for future types. It exports
separate input and row types so read-only Notion values cannot be inserted.
See the [property matrix](docs/PROPERTY_SUPPORT.md) for fidelity and completeness
boundaries.

For code-first evolution, edit the manifest, regenerate, review, and push:

```sh
npx tanstack-db-notion generate --manifest notion.schema.json --out src/notion.generated.ts
npx tanstack-db-notion push --dry-run --env .env --manifest notion.schema.json
npx tanstack-db-notion push --env .env --manifest notion.schema.json --out src/notion.generated.ts
```

`push --dry-run` prints the schema diff without modifying Notion. `push` applies
additive changes and renames after showing that same diff. Type changes
and option removals require `--accept-data-loss`. Operations Notion cannot
safely express through its API are rejected with instructions to make that
change in Notion and run `pull`. `check` is the CI-friendly drift detector, and
`pull` merges live properties and stable IDs back into an existing manifest.

## How synchronization works

```text
React UI
   │ direct optimistic insert / update / delete
   ▼
TanStack DB in-memory collection
   │ persist visible rows + mutation batch before resolving
   ▼
IndexedDB cache ─── durable outbox
   │ online / focus / poll / manual sync
   ▼
Server-only typed sync handler
   │ Notion-Version: 2026-03-11
   ▼
Notion data source pages
```

The collection follows TanStack DB's custom sync lifecycle:

1. Hydrate cached rows from IndexedDB.
2. Commit those rows into the collection and call `markReady()`, even when offline.
3. Store every local transaction in a durable outbox before its collection handler resolves.
4. Apply the mutation to the collection's synced base state so it remains after TanStack drops the temporary optimistic layer.
5. Flush outbox entries in order when online.
6. Page through the Notion data source and atomically reconcile the local materialized state, with still-pending mutations overlaid on top.

The stable `notion.id()` property is important. Notion assigns a page ID only after creation, but offline inserts need a key immediately. The adapter generates a client ID before the network request and stores it in a Notion rich-text property. Each batch and each mutation is checkpointed in the configured server idempotency store. A query by client ID recovers the narrower case where Notion created a page but its own response was lost.

Browser tabs coordinate writes with the Web Locks API when available, then use
a fenced, renewable IndexedDB lease as the fallback. Every persisted envelope
also carries a monotonic revision used for atomic compare-and-set, and tabs
notify one another with `BroadcastChannel`. IndexedDB falls back to
`localStorage` only when Web Locks can still serialize writers. If neither safe
coordination nor durable storage is available, mutations reject rather than
claiming they can survive a reload. A prototype can opt into process-memory fallback through
`createBrowserNotionStorage({ allowMemoryFallback: true })`.

Version-one envelopes migrate to version two before new writes are accepted.
Unknown formats, malformed rows, and legacy pending updates that lack a
property conflict base are moved to quarantine rather than silently cleared.

## Fast queries and pagination

By default, the adapter eagerly materializes the data source locally in Notion
pages of 100 rows. TanStack DB then handles filtering, ordering, and pagination
in memory:

```ts
const { data } = useLiveQuery(
  (query) =>
    query
      .from({ todo: todos })
      .where(({ todo }) => eq(todo.completed, false))
      .orderBy(({ todo }) => todo.createdAt, 'desc')
      .limit(20),
  [],
)
```

Changing `.limit()` is instantaneous and remains available offline because it
does not require another Notion request. This eager model is a good fit for
typical personal and team Notion databases and maximizes offline availability.

For a large, read-only source, opt into progressive materialization. A page ID
can be the key when the source does not have a client-generated ID property:

```ts
const listeningSchema = notionSchema({
  id: notion.pageId(),
  name: notion.title({ id: 'title', name: 'Name' }),
  playedAt: notion.date({ id: 'rVH%3D', name: 'Played At' }),
})

const listening = createCollection(
  notionCollectionOptions({
    id: 'notion-listening',
    endpoint: '/api/listening',
    schema: listeningSchema,
    readOnly: true,
    syncMode: 'progressive',
    pageSize: 100,
  }),
)

await listening.utils.loadMore()
const pagination = listening.utils.getPaginationState()
```

The first sync fetches one page. Each `loadMore()` atomically appends one page
and checkpoints its cursor with the rows. A refresh re-reads every page in the
currently loaded window so inserts, edits, and deletions cannot leave that
window internally inconsistent. Cached pages and the next cursor hydrate after
an offline reload. Progressive sync is deliberately read-only; supporting
local writes against a partial remote snapshot requires a different conflict
and deletion model.

## Type safety

`notionSchema()` is both a Standard Schema implementation and a Notion codec. One declaration provides:

- Collection input and output inference.
- Literal autocomplete for select, multi-select, and status options.
- Defaults for offline inserts.
- Runtime validation for local rows, cached rows, request payloads, and Notion responses.
- Notion page-property serialization.
- Server-side validation that property names and Notion types match the data source.

Supported mappings include:

- Stable client ID (stored as rich text)
- Plain or rich-item title and rich text
- Checkbox and number
- Select, multi-select, and status
- Start-only or complete-range dates, URL, email, and phone number
- Writable people and relations
- Typed read-only files, formula results, rollups, users, and unique IDs
- Created time and last edited time
- Synthetic Notion page ID and page URL metadata

## Collection utilities

The collection exposes adapter-specific utilities under `collection.utils`:

```ts
await todos.utils.syncNow()
await todos.utils.loadMore() // progressive collections only

const state = todos.utils.getSyncState()
const pagination = todos.utils.getPaginationState()
// {
//   status: 'synced' | 'syncing' | 'offline' | 'error' | ...,
//   pendingMutations: number,
//   lastSyncedAt: number | null,
//   isOnline: boolean,
//   storage: 'indexeddb' | 'localstorage' | 'memory' | 'custom' | 'unavailable',
//   error: string | null,
//   quarantine: NotionQuarantineRecord | null,
// }

const unsubscribe = todos.utils.subscribeSyncState(renderStatus)
const pending = await todos.utils.getPendingMutations()
await todos.utils.retryPendingMutation(pending[0].id)
await todos.utils.discardPendingMutation(pending[0].id, {
  acceptDataLoss: true,
})
const quarantined = await todos.utils.getQuarantinedState()
await todos.utils.discardQuarantinedState({ acceptDataLoss: true })
await todos.utils.resetLocalCache()
```

Pending entries record attempt count, last attempt, and a sanitized error. A
failed head entry remains durable and ordered until it succeeds or the user
explicitly accepts data loss and discards it while online.

`resetLocalCache()` clears only local rows and queued mutations, then fetches Notion again when online. It does not delete remote pages.

## Lazy page contents

Enable page-content routes on the same protected handler:

```ts
const handleNotes = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: noteSchema,
  pageContent: true,
  authorize: authorizeRequest,
  idempotencyStore: durableIdempotencyStore,
})
```

Then create a durable browser client:

```ts
const content = createNotionPageContentClient({
  id: 'notes',
  endpoint: '/api/notes',
  debounceMs: 750,
})

await content.load(note.id, note.notionPageId)
await content.update(note.id, nextMarkdown) // durable locally before resolve
await content.flush(note.id) // optional; otherwise debounced
```

The handler verifies that the requested page belongs to its configured data
source. It refuses to replace truncated or unknown content, treats repeated
lost-response writes idempotently, and reports a conflict when the current
remote markdown differs from the draft's base.

## Server behavior

The handler uses the latest Notion API version, `2026-03-11`:

- Reads with `POST /v1/data_sources/{data_source_id}/query` and cursor pagination.
- Creates pages with a `data_source_id` parent.
- Updates page properties with `PATCH /v1/pages/{page_id}`.
- Sends only properties changed by the TanStack DB transaction. The server
  compares their base values to Notion, merges unrelated remote edits, and
  returns a structured `property_conflict` for overlapping edits.
- Deletes by moving a page to trash with `in_trash: true`; Notion does not provide permanent page deletion.
- Spaces outbound requests to respect Notion's average three requests-per-second rate limit.
- Retries network errors, conflicts, rate limits, and 5xx responses with backoff, honoring `Retry-After` for 429 responses.
- Limits a client mutation batch to 50 operations and keeps the token server-side.
- Requires a durable shared idempotency policy and checkpoints individual
  mutations, so retries after a partial batch cannot duplicate earlier inserts.
- Requires endpoint authorization (or an explicit local-development opt-out),
  bounds JSON bodies, times out and cancels Notion calls, and sanitizes unknown
  transport errors.
- Optionally reads and replaces page content with `GET/PATCH
  /v1/pages/{page_id}/markdown`, with source scoping and conflict checks.
- Optionally completes truncated title, rich text, people, and relation values
  through the paginated page-property endpoint.
- Accepts shared/pluggable rate limiting, webhook invalidation, and structured
  content-free request telemetry.

Official references used for the implementation:

- [TanStack DB collection options creator guide](https://tanstack.com/db/latest/docs/guides/collection-options-creator)
- [TanStack DB mutation lifecycle](https://tanstack.com/db/latest/docs/guides/mutations)
- [Notion: query a data source](https://developers.notion.com/reference/query-a-data-source)
- [Notion: create a page](https://developers.notion.com/reference/post-page)
- [Notion: update and trash a page](https://developers.notion.com/reference/patch-page)
- [Notion: working with enhanced Markdown](https://developers.notion.com/guides/data-apis/working-with-markdown-content)
- [Notion API request limits](https://developers.notion.com/reference/request-limits)
- [Notion API version changes](https://developers.notion.com/reference/changes-by-version)
- [Notion personal access tokens](https://developers.notion.com/guides/get-started/personal-access-tokens)

## Current boundaries

- The best fit is an authenticated personal or small-team application with
  frequent interaction, optimistic writes, and meaningful offline use. A
  public, read-heavy site with long CDN cache lifetimes usually benefits more
  from a conventional server cache or build-time data pipeline.
- Property reconciliation is field-aware. It merges unrelated remote edits and
  reports overlapping fields, but it does not attempt semantic merges inside
  one rich-text value or arbitrary page Markdown.
- Eager mutable sync deliberately materializes the whole selected source.
  Progressive materialization is read-only; per-query dynamic filter pushdown
  and mutable partial snapshots are not implemented.
- The package supplies shared interfaces plus one-process memory implementations
  for rate limiting and webhook invalidation. Horizontal/serverless deployments
  must provide distributed implementations. It defines the idempotency contract;
  Daylight supplies a single-host SQLite example, not a universal backend.
- Browser rows, pending edits, and page bodies are not encrypted. Same-origin
  code and anyone using the unlocked browser profile can read them.
- Notion-hosted file URLs expire. The adapter caches typed metadata but does not
  provide an authenticated offline blob store.
- Enhanced Markdown does not represent every Notion block. Replacement is
  refused when Notion reports truncation or unsupported content.
- Place and wiki verification remain raw pending stable fixtures. Cross-browser
  offline automation, a gated exhaustive live-Notion suite, and published
  remote hydration benchmarks remain release follow-ups.

Operational and workflow guides:

- [Schema workflow](docs/schema-workflow.md)
- [Authentication and tenancy](docs/authentication.md)
- [Errors and recovery](docs/errors-and-recovery.md)
- [Large data sources](docs/large-datasets.md)
- [Production operations](docs/operations.md)
- [Durable idempotency stores](docs/idempotency-store.md)

## Development

```sh
npm run typecheck
npm test
npm run build
npm run build:example
npm run test:package

# Standalone Vite+ app
cd apps/todo
npm run check
npm test
npm run build
```

Run the deterministic Reliability Lab on ports 5175 and 8789:

```sh
npm run dev:reliability
```

Its four checks exercise envelope migration/quarantine, the IndexedDB lease
fallback, replay through two rotating server handler instances, and
property-level merge/conflict behavior without touching a real Notion source.

The tests cover schema parsing/serialization, data-source validation, endpoint
authorization and limits, idempotent CRUD, IndexedDB transaction aborts,
fault-injected queue/checkpoint failures, FIFO batching, outbox recovery,
offline hydration, lazy page content, debounced writes, reload recovery,
in-flight coalescing, and content conflicts.
