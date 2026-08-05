# TanStack DB Notion adapter

Offline-first, typed TanStack DB collections backed by Notion data sources.

Local reads and writes are immediate. Rows and pending mutations persist in
IndexedDB, then synchronize through a server endpoint that keeps the Notion
token out of the browser.

> Release status: suitable for authenticated personal and small-team apps.
> Multi-user OAuth provisioning, the full browser matrix, and distributed live
> Notion testing remain outside the current release gate.

## Install

```sh
npm install tanstack-db-notion-adapter @tanstack/react-db
```

Requires Node 20.19 or newer for the server and CLI.

## Connect a Notion data source

Put server-only credentials in `.env`:

```sh
NOTION_PAT=ntn_...
NOTION_DATA_SOURCE_ID=...
```

Then inspect the existing source and generate a checked-in schema:

```sh
npx tanstack-db-notion init \
  --env .env \
  --manifest notion.schema.json \
  --out src/notion.generated.ts \
  --name todoSchema
```

The generated row and input types include literal unions for Notion select and
status options. Property IDs are stored alongside names so renames remain safe.

## Create a collection

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

Mount the same schema behind an authenticated server route:

```ts
import { createNotionSyncHandler } from 'tanstack-db-notion-adapter/server'
import { todoSchema } from './notion.generated'
import { idempotencyStore } from './idempotency-store'

export const handleTodos = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: todoSchema,
  authorize: async (request) => Boolean(await getSession(request)),
  idempotencyStore,
})
```

The handler accepts a Web `Request` and returns a Web `Response`, so it works
with Hono, TanStack Start, Next.js, Bun, Workers, and standard Node adapters.
Production writes require an authorization callback and a durable idempotency
store shared by every server instance.

## Query and mutate

```tsx
import { useLiveQuery } from '@tanstack/react-db'
import { todos } from './todos'

export function TodoList() {
  const { data = [] } = useLiveQuery((query) =>
    query.from({ todo: todos }),
  )

  return data.map((todo) => (
    <label key={todo.id}>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() =>
          todos.update(todo.id, (draft) => {
            draft.completed = !draft.completed
          })
        }
      />
      {todo.title}
    </label>
  ))
}

todos.insert({ title: 'Ship it' })
```

TanStack DB provides reactive local queries, indexes, joins, sorting, and
pagination. The adapter adds IndexedDB hydration, an ordered durable outbox,
cross-tab coordination, typed Notion serialization, retries, and conflict
reporting.

## Keep schemas in sync

```sh
# Preview changes without modifying Notion
npx tanstack-db-notion push --dry-run --env .env --manifest notion.schema.json

# Apply reviewed changes and regenerate TypeScript
npx tanstack-db-notion push \
  --env .env \
  --manifest notion.schema.json \
  --out src/notion.generated.ts

# Pull intentional Notion-side changes
npx tanstack-db-notion pull \
  --env .env \
  --manifest notion.schema.json \
  --out src/notion.generated.ts

# Fail CI when the live source has drifted
npx tanstack-db-notion check --env .env --manifest notion.schema.json
```

See [Schema workflow](docs/schema-workflow.md) and the
[property support matrix](docs/PROPERTY_SUPPORT.md) for managed changes and
type boundaries.

## Page contents

Database properties and page bodies use separate Notion APIs. For editors,
enable `pageContent` on the server and create a lazy content client:

```ts
import { createNotionPageContentClient } from 'tanstack-db-notion-adapter'

export const noteContent = createNotionPageContentClient({
  id: 'notes',
  endpoint: '/api/notes',
  debounceMs: 750,
})
```

Drafts persist locally on every edit. Remote writes are debounced, and content
conflicts retain both versions instead of silently overwriting either one.

## Production boundaries

- Keep `NOTION_PAT` on the server; never use a client-exposed environment name.
- Protect every sync route and scope each user to allowed data sources.
- Use a shared durable idempotency store for every production writer.
- Treat browser storage as private application data and clear it on account changes.
- Use exact data source IDs. Ambiguous multi-source database IDs are rejected.
- Notion-hosted file URLs expire and are not durable offline media.

Read [Authentication](docs/authentication.md),
[Errors and recovery](docs/errors-and-recovery.md), and
[Operations](docs/operations.md) before using production data.

## Examples

- [`examples/todos`](examples/todos): typed properties, local queries, pagination, and mutations.
- [`examples/notes`](examples/notes): lazy page contents, debounced saves, and content conflicts.
- [`examples/reliability`](examples/reliability): executable storage, concurrency, idempotency, and conflict checks.
- [`apps/todo`](apps/todo): a larger authenticated offline task app used as the production acceptance harness.

## License

MIT
