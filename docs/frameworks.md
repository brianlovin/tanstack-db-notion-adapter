# Framework integration

## Next.js App Router

The sync route uses standard Web requests and responses:

```ts
// app/api/journal/route.ts — server
const sync = createNotionSyncHandler({ /* ... */ })

export const GET = sync
export const POST = sync
```

TanStack DB's `useLiveQuery` does not currently provide a server snapshot. A
Client Component is still prerendered by Next.js, so load collection-backed UI
through a separate client-only wrapper:

```tsx
// app/journal/journal-client.tsx — client boundary
'use client'

import dynamic from 'next/dynamic'

const Journal = dynamic(
  () => import('./journal').then((module) => module.Journal),
  { ssr: false },
)

export function JournalClient() {
  return <Journal />
}
```

```tsx
// app/journal/journal.tsx — client only
'use client'

export function Journal() {
  const { data = [] } = useLiveQuery((query) =>
    query.from({ entry: entries }),
  )
  // ...
}
```

Import `JournalClient` from the Server Component. Next.js does not allow
`ssr: false` directly inside a Server Component. Adapter hooks from
`tanstack-db-notion-adapter/react` provide stable server snapshots, but this
wrapper is still required for `useLiveQuery` itself.

## Authenticated startup

If a collection module loads before the browser session is ready, defer remote
requests while still hydrating local data:

```ts
// data/journal.ts — client
export const entries = createCollection(
  notionCollectionOptions({
    id: 'journal',
    endpoint: '/api/journal',
    schema: notionDataSourceSchema,
    autoStart: false,
  }),
)

await entries.utils.resumeSync()
entries.utils.pauseSync()
```

Use the same `autoStart`, `resumeSync`, and `pauseSync` lifecycle for the page-
content client. Pausing does not clear cached rows, drafts, or pending writes.

## Offline app shell

The adapter persists rows, mutations, and page drafts. The host application
must cache its own HTML and JavaScript with a service worker or equivalent if
the app itself must reload without a network connection. Never let a navigation
fallback turn an `/api` failure into cached HTML.
