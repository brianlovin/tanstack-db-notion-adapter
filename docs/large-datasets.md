# Large data sources

Choose materialization based on product behavior, not row count alone.

## Eager mutable collections

The default `syncMode: 'eager'` fetches every Notion page and then atomically
replaces the local snapshot. TanStack DB serves filters, sorting, and pagination
from memory, so repeated interaction is instant and offline. This is the right
default for task, notes, CRM, inventory, or field applications where users edit
data and expect global local queries.

Costs are initial Notion requests, browser memory, and IndexedDB size. Render
large lists with virtualization and stable keys; a historical acceptance run
covered a 10,000-row local query/sort regression and a virtualized task list.

## Progressive read-only collections

For a large archive or public history that is not edited in the app:

```ts
notionCollectionOptions({
  id: 'history',
  endpoint: '/api/history',
  schema: historySchema,
  readOnly: true,
  syncMode: 'progressive',
})
```

Call `collection.utils.loadMore()` as the user approaches the end and inspect
`getPaginationState()`. Rows and the remote cursor persist as one atomic
checkpoint, so reload resumes the loaded window. Progressive mutable snapshots
are intentionally forbidden: editing a partially materialized source makes
conflict and deletion semantics ambiguous.

## Server-side filters and sorts

Use fixed typed `filter` and `sorts` on the server handler to define the source
boundary. Local UI queries still run in TanStack DB. Filters are not currently
rewritten per live query, so this is source partitioning rather than arbitrary
query pushdown.

Prefer stable field keys:

```ts
createNotionSyncHandler({
  // ...
  filter: { field: 'archived', operator: 'equals', value: false },
  sorts: [{ field: 'updatedAt', direction: 'descending' }],
})
```

## Request and refresh budget

- Notion returns at most 100 rows per query page.
- Collections poll every 60 seconds by default and reconcile when a background
  tab becomes visible. Set `pollIntervalMs: 0` to disable periodic refresh.
- `completeProperties` adds paginated property requests per row and field.
- Share one `NotionRateLimiter` for handlers using the same connection.
- Add webhook invalidation for low-latency refresh, but keep periodic polling as
  recovery for missed events.
- Unchanged snapshots do not republish collection updates.
- Page content is lazy and cached by page; never fetch every page body during
  collection hydration.

Measure cold hydration, cached startup, memory, IndexedDB size, and reconnect
time against representative data before choosing a mobile/browser support
budget. The package does not yet publish cross-browser 1,000/10,000-row remote
hydration benchmarks.

## Files and offline media

File metadata can be cached, but Notion-hosted download URLs expire. Offline
media requires an application-owned blob cache or proxy with its own auth,
storage quota, eviction, and refresh policy. The adapter does not download or
encrypt files automatically.
