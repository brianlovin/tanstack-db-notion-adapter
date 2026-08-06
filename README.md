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

Requires Node 20.19 or newer. From an existing app with a `src/` directory:

```sh
npm install tanstack-db-notion-adapter @tanstack/react-db
npx tanstack-db-notion init
```

`init` asks for your PAT and a Notion database link or ID. It stores the server
configuration in `.env.local` and creates:

- `notion.schema.json` — the checked-in schema contract
- `src/notion.generated.ts` — the generated TypeScript schema and types

For a coding agent or other non-interactive environment, create the env file
first and pass the database directly:

```dotenv
# .env.local — server only
NOTION_PAT=MY_PAT
```

```sh
npx tanstack-db-notion init --id "NOTION_DATABASE_URL"
```

Use `--out` if your project does not use a `src/` directory.

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
  schema: notionDataSourceSchema,
  pageContent: true,
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

Next.js users should mount the collection below a client-only boundary; see
[framework integration](docs/frameworks.md#nextjs-app-router-and-ssr).

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
import { entries } from './data/journal'

entries.insert({ title: 'Today' })
entries.update(entry.id, (draft) => {
  draft.title = 'A better title'
})
entries.delete(entry.id)
```

The generated file also exports `NotionDataSourceSchemaInput` for inserts and
update helpers, and `NotionDataSourceSchemaRow` for fetched records. The input
type omits read-only Notion metadata.

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

Attach an existing row before rendering its body. The hook subscribes to local
state; `attachPage` performs the initial fetch:

```tsx
// src/Editor.tsx — client
import { useNotionPageContent } from 'tanstack-db-notion-adapter/react'
import { useEffect } from 'react'
import { entryContent } from './data/journal-content'
import type { NotionDataSourceSchemaRow } from './notion.generated'

export function Editor({ entry }: { entry: NotionDataSourceSchemaRow }) {
  const content = useNotionPageContent(entryContent, entry.id)

  useEffect(() => {
    if (entry.notionPageId) {
      void entryContent.attachPage(entry.id, entry.notionPageId)
    }
  }, [entry.id, entry.notionPageId])

  return (
    <textarea
      value={content?.markdown ?? ''}
      disabled={!content}
      onChange={(event) => {
        void entryContent.update(entry.id, event.target.value)
      }}
    />
  )
}
```

Create a durable body before inserting a new row so both can flush after an
offline session:

```ts
// src/actions.ts — client
import { entries } from './data/journal'
import { entryContent } from './data/journal-content'

const id = crypto.randomUUID()
await entryContent.createDraft(id, '# Today')
entries.insert({ id, title: 'Today' })
```

The hook watches only the open page. It revalidates that page on window focus
and every 60 seconds without refetching every page body.

See [page-content sync](docs/page-content.md) for creating drafts, debounced
writes, direct Notion edits, webhooks, and conflict handling.

## Schema changes

The CLI automatically loads `.env.local`, `.env`, `notion.schema.json`, and
`src/notion.generated.ts`:

```sh
npx tanstack-db-notion push --dry-run  # preview local changes
npx tanstack-db-notion push            # apply local changes to Notion
npx tanstack-db-notion pull            # accept changes made in Notion
npx tanstack-db-notion check           # detect all remote drift in CI
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

For authenticated startup, offline app-shell caching, and other framework
details, see [framework integration](docs/frameworks.md).

## License

MIT
