# TanStack DB Notion adapter

Build fast, offline-capable apps with TanStack DB while keeping Notion as the
source of truth. Reads and writes happen locally first, then sync through your
server with generated end-to-end types.

Best for private tools that people actively use: journals, task managers,
lightweight CRMs, and small-team workflows.

## Quick start

### 1. Install and generate a schema

```sh
npm install tanstack-db-notion-adapter @tanstack/react-db
npx tanstack-db-notion init
```

`init` asks for your PAT and a Notion database link or ID. It stores the server
configuration in `.env.local` and creates:

- `notion.schema.json` — the checked-in schema contract
- `notion.generated.ts` — the generated TypeScript schema and types

Keep the PAT server-only. Do not expose it to browser code.

### 2. Apply the schema

Preview, then apply, the one-time Notion schema setup:

```sh
npx tanstack-db-notion push --dry-run
npx tanstack-db-notion push
```

`push` adds the visible `Client ID` rich-text property when it is missing. The
adapter uses that property as the stable client-owned key, which lets offline
inserts reconcile after retries instead of creating duplicate Notion pages.

### 3. Add the server route

The Notion PAT must never enter the browser. Mount one handler and expose both
`GET` and `POST` at the same path:

```ts
// app/api/journal/route.ts — server
import {
  createMemoryNotionIdempotencyStore,
  createNotionSyncHandler,
} from 'tanstack-db-notion-adapter/server'
import { notionDataSourceSchema } from '../../../notion.generated'

const sync = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  schema: notionDataSourceSchema,
  idempotencyStore: createMemoryNotionIdempotencyStore(),
  dangerouslyAllowUnauthenticated: true,
})

export const GET = sync
export const POST = sync
```

This is the shortest local-development route. See
[production recommendations](#production-recommendations) when deciding how to
deploy it.

### 4. Create the collection

```ts
// data/journal.ts — client
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

### 5. Read it with `useLiveQuery`

```tsx
// Journal.tsx — client
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
entries.insert({ title: 'Today' })
entries.update(entry.id, (draft) => {
  draft.title = 'A better title'
})
entries.delete(entry.id)
```

The generated file also exports `NotionDataSourceSchemaInput` for inserts and
update helpers, and `NotionDataSourceSchemaRow` for fetched records. The input
type omits read-only Notion metadata.

### Production recommendations

Choose the safeguards that fit how your app is deployed:

- **Protect the sync route.** Add `authorize` or enforce access before the
  handler when the endpoint should not be public. See
  [authentication](docs/authentication.md).
- **Use shared durable idempotency for multi-instance servers.** This keeps
  retries handled consistently across processes. See
  [durable idempotency stores](docs/idempotency-store.md).
- **Surface blocked mutations when users need recovery controls.**
  `tx.isPersisted` means the mutation is durable on this device, not that
  Notion accepted it. See [errors and recovery](docs/errors-and-recovery.md).
- **Scope browser storage before supporting account switching.** Resolve an
  opaque stable account/workspace ID before constructing either client, then
  pass it as `storageScope`. See [authentication](docs/authentication.md).

## Mutations and recovery

This adapter differs from a server-confirmed TanStack DB workflow: it writes
local mutations into the synced base itself and resolves the mutation handler
once the write is durable locally. `tx.isPersisted` therefore means “saved on
this device,” not “saved in Notion.” A server rejection never rejects the
transaction and there is no automatic rollback. Observe failures through sync
state and recover them explicitly.

Use the returned TanStack transaction as an adapter receipt when one product
action needs an exact remote outcome:

```ts
const tx = entries.update(entry.id, (draft) => {
  draft.title = 'A better title'
})

await tx.isPersisted.promise // durable locally
const result = await entries.utils.awaitRemote(tx)
// result.status: 'synced' | 'blocked' | 'cancelled'
```

`awaitRemote` observes the FIFO outbox; it does not bypass earlier work or force
a synchronization attempt. `getRemoteTransactionStatus(tx)` provides the
non-blocking form and reports bounded-chunk progress for bulk transactions.
The latest 100 terminal receipts are durable by default.

Undo may cancel a transaction only before any of its chunks begins delivery:

```ts
await entries.utils.cancelRemoteTransaction(tx)
```

Cancellation atomically rolls back its optimistic rows and rebases later
pending updates. If delivery was attempted or acknowledged, enqueue an ordinary
inverse collection mutation instead.

Use `blockedMutation` from `useNotionSyncState` to show when the FIFO outbox
head needs attention:

```tsx
import { useNotionSyncState } from 'tanstack-db-notion-adapter/react'
import { entries } from './data/journal'

export function SyncNotice() {
  const sync = useNotionSyncState(entries)
  const blocked = sync.blockedMutation
  if (!blocked) return null

  return (
    <aside>
      <p>Could not save changes: {blocked.error.message}</p>
      <button
        onClick={() =>
          void entries.utils.retryPendingMutation(blocked.entryId)
        }
      >
        Retry
      </button>
      <button
        onClick={() =>
          void entries.utils.discardPendingMutation(blocked.entryId, {
            acceptDataLoss: true,
          })
        }
      >
        Discard local change
      </button>
    </aside>
  )
}
```

`blockedMutation` is populated only for a non-retryable failure at the head of
the outbox. Transient failures remain retryable and do not populate this
field. See [errors and recovery](docs/errors-and-recovery.md) for conflict
handling and durable recovery.

Sync state also reports `integrity`, `lastFullReconciledAt`, and
`nextFullReconciliationAt`. Incremental polling finds edited rows but cannot
prove that remotely deleted or newly filtered-out rows are gone. Call
`collection.utils.fullReconcileNow()` when the UI needs an explicit integrity
refresh; `syncNow()` remains a compatible alias for a full reconciliation.

When a row was deleted remotely while its local update was pending, resolve the
blocked head without throwing away the edit:

```ts
await entries.utils.resolveDeletedMutation(blocked.entryId, {
  action: 'recreate',
})
// Or explicitly discard the local row and edit:
await entries.utils.resolveDeletedMutation(blocked.entryId, {
  action: 'discard',
  acceptDataLoss: true,
})
```

## Page contents

Database properties and page bodies are separate in Notion. For journals and
notes, enable `pageContent: true` on the server and create a content client:

```ts
// data/journal-content.ts — client
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
// Editor.tsx — client
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
const id = crypto.randomUUID()
await entryContent.createDraft(id, '# Today')
entries.insert({ id, title: 'Today' })
```

If creation is cancelled, remove the durable local body explicitly. This does
not change an attached Notion page:

```ts
await entryContent.discardDraft(id, { acceptDataLoss: true })
```

The hook watches only the open page. It revalidates that page on window focus
and every 60 seconds without refetching every page body.

See [page-content sync](docs/page-content.md) for creating drafts, debounced
writes, direct Notion edits, webhooks, and conflict handling.

## Schema commands

The CLI automatically loads `.env.local`, `.env`, and `notion.schema.json`, then
regenerates `notion.generated.ts`:

```sh
npx tanstack-db-notion push --dry-run  # preview local changes
npx tanstack-db-notion push            # apply local changes to Notion
npx tanstack-db-notion pull            # accept changes made in Notion
npx tanstack-db-notion check           # detect all remote drift in CI
```

Advanced paths, non-interactive setup, `--out`, and destructive changes are
covered in the [schema workflow](docs/schema-workflow.md).

## Limits and unsupported behavior

- A row deleted in Notion can remain locally until the next full
  reconciliation, up to the configured interval (one hour by default).
- More than 10,000 matching rows in one data source is unsupported; Notion
  truncates pagination at that boundary. See
  [large data sources](docs/large-datasets.md).
- If a page is deleted in Notion while a local edit is pending, that mutation
  blocks until you explicitly recreate the row from the local value or discard
  it with data-loss acknowledgement.
- Concurrent edits to the same property surface as `property_conflict`.
  There is no automatic semantic merge; resolve the conflict explicitly.
- Page bodies are Markdown-only. Pages containing content the adapter cannot
  represent are read-only through the page-content client.
- Files and offline media are not cached. Notion-hosted file URLs expire.
- Page-content drafts for deleted rows are not pruned from local storage.

## Examples

- [`examples/todos`](examples/todos) — typed properties, optimistic mutations,
  local filtering, and pagination
- [`examples/notes`](examples/notes) — lazy page bodies, debounced writes,
  direct-Notion refresh, and conflicts
- [`examples/reliability`](examples/reliability) — executable failure and
  recovery scenarios

Local queries stay fast across thousands of cached rows. Notion limits one
data-source query to 10,000 matching pages; the adapter fails closed at that
boundary instead of silently returning partial data. See
[large data sources](docs/large-datasets.md) for filtering, progressive reads,
bulk-write costs, and refresh budgets.

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

## License

MIT
