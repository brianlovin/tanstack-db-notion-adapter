# TanStack DB Notion adapter

Offline-first, end-to-end typed TanStack DB collections backed by Notion data
sources. Reads and writes happen locally first; an ordered durable outbox then
syncs through your authenticated server.

Best suited to private, authenticated tools where Notion is the source of truth:
task managers, journals, lightweight CRMs, and team workflows.

## Install

```sh
npm install tanstack-db-notion-adapter @tanstack/react-db
```

The server and CLI require Node 20.19 or newer.

## 1. Generate a typed schema

Create a [Notion personal access token](https://developers.notion.com/guides/get-started/personal-access-tokens)
for a user who can access the database, and keep it server-only:

```sh
NOTION_PAT=ntn_...
```

Paste the database URL directly into `init`; the CLI resolves its data source ID:

```sh
npx tanstack-db-notion init \
  --env .env \
  --id "https://app.notion.com/p/your-workspace/..." \
  --manifest notion.schema.json \
  --out src/notion.generated.ts \
  --name todoSchema
```

Commit both generated files. The manifest stores stable property IDs, so a
Notion-side rename does not break sync. It also contains the exact
`dataSourceId`; copy that value to your server environment:

```sh
NOTION_DATA_SOURCE_ID=...
```

`init` plans a visible rich-text property named `Client ID` when the source does
not already have one. Running `push` adds it. This is the adapter's stable key
for offline inserts and idempotent reconciliation.

## 2. Mount one server route

The handler takes a standard Web `Request` and returns a Web `Response`. The
browser and server must use the same generated schema. This complete Next.js
App Router example is for localhost only:

```ts
import {
  createMemoryNotionIdempotencyStore,
  createNotionSyncHandler,
} from 'tanstack-db-notion-adapter/server'
import { todoSchema } from './notion.generated'

const handler = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: todoSchema,
  idempotencyStore: createMemoryNotionIdempotencyStore(),
  dangerouslyAllowUnauthenticated: true,
})

export const GET = handler
export const POST = handler
```

Mount both methods at exactly the same path, such as `/api/todos`. The adapter
uses query-string actions on that path for schema checks, invalidation, and page
content; no additional routes are required.

For production, replace `dangerouslyAllowUnauthenticated` with `authorize` and
replace the memory store with a durable store shared by every writer. See
[authentication](docs/authentication.md) and the
[idempotency contract](docs/idempotency-store.md). For a read-only source, set
`readOnly: true` and omit the idempotency store.
`dangerouslyAllowEphemeralIdempotency: true` is also available for disposable
single-process prototypes, but must never be used for production writes.

If server code receives a database ID or URL instead of a data source ID, resolve
it explicitly:

```ts
import { resolveNotionDataSourceId } from 'tanstack-db-notion-adapter/server'

const dataSourceId = await resolveNotionDataSourceId({
  token: process.env.NOTION_PAT!,
  id: process.env.NOTION_DATABASE_ID_OR_URL!,
})
```

Databases with multiple data sources are rejected with a list of valid choices.

## 3. Create and use the collection

```ts
import { createCollection } from '@tanstack/react-db'
import { notionCollectionOptions } from 'tanstack-db-notion-adapter'
import { todoSchema } from './notion.generated'

export const todos = createCollection(
  notionCollectionOptions({
    id: 'todos',
    endpoint: '/api/todos',
    schema: todoSchema,
  }),
)
```

TanStack DB mutations are optimistic and immediately durable:

```ts
todos.insert({ title: 'Ship it' })

todos.update(todo.id, (draft) => {
  draft.completed = !draft.completed
})
```

The generated `TodoSchemaInput` type is the draft shape for both inserts and
updates. Fields with defaults may be optional. The generated `TodoSchemaRow`
type is the complete synced row, including Notion metadata.

TanStack DB currently uses the insert input type for update callbacks, so a
defaulted field can appear optional even though synced rows always contain it.
Read the current value from the row when updating arrays:

```ts
todos.update(todo.id, (draft) => {
  draft.tags = todo.tags.includes('Important')
    ? todo.tags.filter((tag) => tag !== 'Important')
    : [...todo.tags, 'Important']
})
```

Use `useLiveQuery` normally; filtering, sorting, joins, and pagination operate
against the local collection:

```tsx
import { eq, useLiveQuery } from '@tanstack/react-db'

const { data: openTodos = [] } = useLiveQuery((query) =>
  query
    .from({ todo: todos })
    .where(({ todo }) => eq(todo.completed, false)),
)
```

The collection reconciles with Notion every 60 seconds by default and when a
background tab becomes visible. Set `pollIntervalMs: 0` to disable polling or
configure `invalidationPollIntervalMs` when using webhook invalidation.

### Next.js App Router

`useLiveQuery` does not provide a server snapshot. A `'use client'` component
is still prerendered by Next.js, so render collection-backed UI through a
client-only dynamic wrapper:

```tsx
// journal-client.tsx
'use client'

import dynamic from 'next/dynamic'

const Journal = dynamic(() => import('./journal').then((module) => module.Journal), {
  ssr: false,
})

export function JournalClient() {
  return <Journal />
}
```

```tsx
// journal.tsx
'use client'

export function Journal() {
  const { data = [] } = useLiveQuery((query) => query.from({ entry: entries }))
  // ...
}
```

Import `JournalClient` from the Server Component. Next.js does not allow
`ssr: false` directly inside a Server Component.

## Authenticated startup

If the collection module loads before the user's session, prevent the initial
request and resume only after authentication succeeds:

```ts
export const todos = createCollection(
  notionCollectionOptions({
    id: 'todos',
    endpoint: '/api/todos',
    schema: todoSchema,
    autoStart: false,
  }),
)

await todos.utils.resumeSync() // after login/session restoration
todos.utils.pauseSync()        // before logout or an account switch
```

Pausing never clears cached rows or pending mutations. `syncNow()` remains an
explicit one-off retry, and a successful retry clears an earlier sync error.

## Schema changes

```sh
# Preview without changing Notion
npx tanstack-db-notion push --dry-run --env .env --manifest notion.schema.json

# Apply, pull stable IDs, and regenerate TypeScript
npx tanstack-db-notion push \
  --env .env --manifest notion.schema.json --out src/notion.generated.ts

# Accept intentional Notion-side changes
npx tanstack-db-notion pull \
  --env .env --manifest notion.schema.json --out src/notion.generated.ts

# Exit 1 when live Notion and the manifest differ
npx tanstack-db-notion check --env .env --manifest notion.schema.json
```

Type changes and option removal require `--accept-data-loss`. See the
[schema workflow](docs/schema-workflow.md) and
[property support matrix](docs/PROPERTY_SUPPORT.md).

## Page contents

Database properties and page bodies are separate Notion APIs. Enable
`pageContent: true` on the server, then create a lazy client:

```ts
import { createNotionPageContentClient } from 'tanstack-db-notion-adapter'

const noteContent = createNotionPageContentClient({
  id: 'notes',
  endpoint: '/api/notes',
  collection: notes,
  debounceMs: 750,
  autoStart: false,
})
```

For an authenticated app, call `noteContent.resumeSync()` with the collection
after session restoration and `noteContent.pauseSync()` before logout. Omit
`autoStart` when the endpoint is ready as soon as the client loads.

Create the durable body draft before inserting its row. Passing `collection`
lets the client observe every row—not only the selected one—and attach the
Notion page ID as soon as the offline insert syncs:

```ts
const id = crypto.randomUUID()
await noteContent.createDraft(id, '# New note')
notes.insert({ id, title: 'New note' })

await noteContent.attachPage(note.id, note.notionPageId) // open existing page
await noteContent.update(note.id, nextMarkdown)    // local save + debounced flush
await noteContent.flush(note.id)                   // explicit retry/save-now
```

Use `attachPage` when opening an existing page: it creates the local record when
needed, loads the remote body, and schedules any pending draft. `load` is the
lower-level remote read. If `collection` is omitted, the application must call
`attachPage` for every draft whose row receives a page ID.

React bindings provide SSR-safe subscriptions for adapter state:

```tsx
import {
  useNotionPageContent,
  useNotionSyncState,
} from 'tanstack-db-notion-adapter/react'

const sync = useNotionSyncState(notes)
const content = useNotionPageContent(noteContent, selectedId)
```

Pending drafts retry after recreation and when connectivity returns.
Conflicts retain both versions; resolve with `acceptRemote` or the explicit
`overwriteRemote({ acceptDataLoss: true })` escape hatch.

## Offline boundary

The adapter persists collection rows, pending mutations, and page drafts in
browser storage. To reload the application itself with no network, the host app
must also cache its HTML and assets with a service worker or equivalent app-shell
strategy.

Keep the Notion token off the client, authorize every production request, clear
private browser data on account changes, and remember that Notion-hosted file
URLs expire. See [errors and recovery](docs/errors-and-recovery.md) and
[production operations](docs/operations.md).

## Examples

- [`examples/todos`](examples/todos): typed properties and mutations.
- [`examples/notes`](examples/notes): debounced page contents and conflicts.
- [`examples/reliability`](examples/reliability): executable reliability checks.
- [`apps/todo`](apps/todo): authenticated production acceptance harness.

## License

MIT
