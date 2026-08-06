# Large data sources

The adapter is designed for thousands of locally queryable rows. [Notion caps a
single data-source query at 10,000 matching
results](https://developers.notion.com/reference/query-a-data-source), so
tens-of-thousands-scale sources need an explicit partitioning strategy. Choose
materialization based on the application's active working set, not the source's
lifetime row count.

## Eager mutable collections

The default `syncMode: 'eager'` fetches every Notion page and then atomically
replaces the local snapshot. TanStack DB serves filters, sorting, and pagination
from memory, so repeated interaction is instant and offline. This is the right
default for task, notes, CRM, inventory, or field applications where users edit
data and expect global local queries.

Costs are initial Notion requests, browser memory, IndexedDB size, and repeated
full refreshes. Render large lists with virtualization and stable keys; a
historical acceptance run covered a 10,000-row local query/sort regression and
a virtualized task list.

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

An active-tasks collection can, for example, exclude completed work while a
separate read-only history collection uses a date range. Filters for separate
collections must be disjoint if the application later combines their rows.

## The 10,000-result boundary

Notion stops pagination after 10,000 matching results and marks the response as
incomplete. The handler returns `notion_query_result_limit` instead of accepting
that truncated response as a complete local snapshot.

- Fewer than 10,000 matching rows: use eager mode for editable working sets or
  progressive mode for read-only archives.
- More than 10,000 total rows but fewer than 10,000 per useful view: create
  collections with fixed server filters, such as active versus completed or
  bounded date ranges.
- More than 10,000 rows that must behave as one complete mutable collection:
  this is not supported yet. Split the source or the product boundary. Do not
  hide the limit by accepting a partial snapshot.

Automatic range partitioning is intentionally not inferred. Timestamp
boundaries can contain ties, user filters can overlap, and a partial mutable
snapshot would weaken deletion and conflict guarantees.

## Request and refresh budget

- Notion returns at most 100 rows per query page.
- Cold hydration of `N` rows requires at least `ceil(N / 100)` query requests,
  plus schema validation and any paginated property requests.
- Collections poll every 60 seconds by default and reconcile when a background
  tab becomes visible. For sources with thousands of rows, prefer webhook
  invalidation, lengthen this interval, or set `pollIntervalMs: 0` when the
  application owns another refresh trigger.
- `completeProperties` adds paginated property requests per row and field.
- Share one `NotionRateLimiter` for handlers using the same connection.
- Add webhook invalidation for low-latency refresh, but keep periodic polling as
  recovery for missed events.
- Unchanged snapshots do not republish collection updates.
- Page content is lazy and cached by page; never fetch every page body during
  collection hydration.

[Notion applies an average request budget per
connection](https://developers.notion.com/reference/request-limits). Adding
server instances that use the same connection does not create more capacity;
every instance should use a distributed limiter with the same
`rateLimitScope`.

## Bulk writes

For a batch of up to 50 inserts, the handler performs one filtered lookup for
all client IDs and then one page-create request per new row. A fully new batch
therefore needs `N + 1` Notion requests rather than `2N`. The lookup preserves
duplicate prevention and lost-response recovery.

Notion does not provide a bulk page-create endpoint, so large initial imports
remain bounded by one create request per row and the connection's rate limit.
Treat the adapter as an interactive sync system, not a high-throughput ETL
pipeline. If an application must seed tens of thousands of rows, plan a
separate controlled import that also populates the adapter's stable client-ID
property.

Use the handler's `onEvent` hook to measure counts, latency, retries, and errors
by operation. Events omit credentials, request bodies, and row content. Watch
`data_source.query`, `page.create`, 429 and transient server responses, and
total cold-hydration time against production-shaped fixtures.

Measure cold hydration, cached startup, memory, IndexedDB size, and reconnect
time against representative data before choosing a mobile/browser support
budget. The package does not yet publish cross-browser 1,000/10,000-row remote
hydration benchmarks.

## Files and offline media

File metadata can be cached, but Notion-hosted download URLs expire. Offline
media requires an application-owned blob cache or proxy with its own auth,
storage quota, eviction, and refresh policy. The adapter does not download or
encrypt files automatically.
