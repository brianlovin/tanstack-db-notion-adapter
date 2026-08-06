# TanStack DB Notion adapter

Build fast, offline-capable apps with TanStack DB while keeping Notion as the
source of truth. Reads and writes happen locally first, then sync through your
server with generated end-to-end types.

Best for private tools that people actively use: journals, task managers,
lightweight CRMs, and small-team workflows.

## Prompt for coding agents

Replace the placeholders and give this to a trusted local coding agent:

```text
Use https://github.com/brianlovin/tanstack-db-notion-adapter and TanStack DB to
build a simple, minimal journaling app using a Notion database as my data
storage.

My Notion PAT is: MY_PAT
My Journal database is: NOTION_DATABASE_URL

Keep the PAT server-only in .env.local. Use the adapter's generated schema,
authenticated server route, offline collection, and page-content client.
```

The repository includes an [agent skill](skills/tanstack-db-notion/SKILL.md)
with the complete setup and safety workflow.

## Quick start

```sh
npm install tanstack-db-notion-adapter @tanstack/react-db
npx tanstack-db-notion init
```

`init` asks for your PAT and a Notion database link or ID. It stores prompted
server credentials in `.env.local` and creates:

- `notion.schema.json` — the checked-in schema contract
- `src/notion.generated.ts` — the generated TypeScript schema and types

Review and apply the one-time schema setup:

```sh
npx tanstack-db-notion push --dry-run
npx tanstack-db-notion push
```

This may add a visible `Client ID` property to Notion. The adapter uses it to
reconcile offline inserts without creating duplicate pages.

## Add the server route

The Notion PAT must never enter the browser. Mount the sync handler on your
server and expose both `GET` and `POST` at one path:

```ts
// app/api/journal/route.ts — server
import {
  createMemoryNotionIdempotencyStore,
  createNotionSyncHandler,
} from 'tanstack-db-notion-adapter/server'
import { notionDataSourceSchema } from '@/notion.generated'

const sync = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: notionDataSourceSchema,
  idempotencyStore: createMemoryNotionIdempotencyStore(),
  dangerouslyAllowUnauthenticated: true,
})

export const GET = sync
export const POST = sync
```

This configuration is for local development. Before deployment, add `authorize`
and use a durable idempotency store shared by every server instance. See
[authentication](docs/authentication.md) and
[production operations](docs/operations.md).

## Create the collection

```ts
// src/data/journal.ts — client
import { createCollection } from '@tanstack/react-db'
import { notionCollectionOptions } from 'tanstack-db-notion-adapter'
import { notionDataSourceSchema } from '../notion.generated'

export const entries = createCollection(
  notionCollectionOptions({
    id: 'journal',
    endpoint: '/api/journal',
    schema: notionDataSourceSchema,
  }),
)
```

Query it like any TanStack DB collection:

```tsx
// src/Journal.tsx — client
import { useLiveQuery } from '@tanstack/react-db'
import { entries } from './data/journal'

export function Journal() {
  const { data = [] } = useLiveQuery((query) =>
    query.from({ entry: entries }),
  )

  return data.map((entry) => <article key={entry.id}>{entry.title}</article>)
}
```

Mutations are optimistic and persist offline immediately:

```ts
// src/actions.ts — client
entries.insert({ title: 'Today' })

entries.update(entry.id, (draft) => {
  draft.title = 'A better title'
})

entries.delete(entry.id)
```

## Page contents

Database properties and page bodies are separate in Notion. For journals and
notes, enable `pageContent: true` on the server and create a content client:

```ts
// src/data/journal-content.ts — client
import { createNotionPageContentClient } from 'tanstack-db-notion-adapter'
import { entries } from './journal'

export const entryContent = createNotionPageContentClient({
  id: 'journal',
  endpoint: '/api/journal',
  collection: entries,
})
```

The React hook watches only the open page. It revalidates that page on window
focus and every 60 seconds, so edits made directly in Notion appear without
refetching every page body.

```tsx
// src/Editor.tsx — client
import { useNotionPageContent } from 'tanstack-db-notion-adapter/react'

const content = useNotionPageContent(entryContent, selectedEntryId)
```

See [page-content sync](docs/page-content.md) for creating drafts, debounced
writes, direct Notion edits, webhooks, and conflict handling.

## Schema changes

The CLI automatically loads `.env.local`, `.env`, `notion.schema.json`, and
`src/notion.generated.ts`:

```sh
npx tanstack-db-notion push --dry-run  # preview local changes
npx tanstack-db-notion push            # apply local changes to Notion
npx tanstack-db-notion pull            # accept changes made in Notion
npx tanstack-db-notion check           # detect drift in CI
```

Advanced paths and destructive changes are covered in the
[schema workflow](docs/schema-workflow.md).

## Examples

- [`examples/todos`](examples/todos) — typed properties, optimistic mutations,
  local filtering, and pagination
- [`examples/notes`](examples/notes) — lazy page bodies, debounced writes,
  direct-Notion refresh, and conflicts
- [`examples/reliability`](examples/reliability) — executable failure and
  recovery scenarios

For Next.js SSR, authenticated startup, offline app-shell caching, and other
framework details, see [framework integration](docs/frameworks.md). The server
and CLI require Node 20.19 or newer.

## License

MIT
