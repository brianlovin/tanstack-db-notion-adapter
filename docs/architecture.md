# Architecture

```text
React / TanStack DB
  │ optimistic rows and lazy page-body drafts
  ▼
IndexedDB
  │ versioned rows + FIFO outbox + revision CAS + fenced writer lease
  ▼
Authorized application endpoint
  │ schema validation, limits, retries, conflict checks
  ▼
Notion data source + page Markdown APIs
```

## Trust boundaries

The browser is untrusted and never receives a Notion credential. It may propose
rows, page IDs, and mutations; the server authenticates the application user,
authorizes source access, validates the schema and row, and verifies a requested
page belongs to the configured data source. Property mutations resolve stable
client IDs through the configured data-source query endpoint and reject a
client-supplied page ID that identifies a different page.

The CLI is a trusted local process. It reads the PAT and source ID from env,
inspects schema metadata, and writes a non-secret manifest and generated types.
Schema tooling is an internal CLI Module rather than a supported package export.

## Internal module map

- `client` and `content-client` keep their separate public responsibilities but
  share private browser lifecycle, request, and serialized-operation machinery.
- `server` is the public composition point. Private request and mutation Modules
  own Notion transport policy and idempotent mutation execution respectively.
- `notion-source` resolves database URLs and IDs without importing the sync
  server, so schema tooling depends only on the Notion calls it needs.
- `property-capabilities` is the canonical registry for generated schema
  builders, option-bearing properties, and schema-push support.

## Collection state flow

Hydration validates cached rows, commits them to TanStack DB, and marks the
collection ready even while offline. During a first eager remote hydration,
each complete page is added to the visible and durable local bootstrap while
`lastSyncedAt` remains unset. The final page atomically replaces that additive
bootstrap with the authoritative complete snapshot. A local transaction is
normalized, split into at most 50-mutation batches, and committed to durable
storage before the TanStack mutation handler resolves. The collection's synced
base state changes only after that commit.

Synchronization acquires Web Locks or a renewable IndexedDB lease and reloads
shared storage. The write path flushes the outbox head in FIFO order and applies
the authoritative returned rows without rereading the collection. When webhook
invalidation is configured, a mutation acknowledgement advances the local
version only if no unrelated invalidation interleaved with the write; otherwise
it catches up before declaring the collection current. Normal focus, polling,
and reconnect requests query inclusively from the greatest incorporated Notion
`last_edited_time` and merge changed rows. Explicit sync and a periodic integrity
interval retrieve a complete snapshot so deletions, missed webhooks, and filter
membership changes eventually reconcile. Pending mutations overlay remote
values. Both acknowledgement checkpoints and refreshed snapshots commit with
an atomic revision comparison before they are published in memory. A stale
writer retries rather than overwriting newer state. Unknown persisted formats
move to quarantine; they are never silently replaced by an empty envelope.

The server runs each batch and each individual mutation through a durable
idempotency-store contract. The store is shared across handler instances and
persists successful results. Individual checkpoints make partial batch retries
safe. Before executing a mutation batch, one compound query resolves all stable
client IDs in the configured data source; newly created pages are added to that
result as execution continues. Inserts use the result for duplicate prevention,
while updates use it for conflict checks and deletes use it to find their page.
This keeps identity resolution at one lookup per batch instead of one lookup per
row. If a page-create response disappears, the handler does not blindly repeat
the ambiguous create request. The next outbox attempt performs the lookup again
and recovers the page Notion already created.

Notion marks queries that exceed its 10,000-result pagination depth as
incomplete. The server rejects such a response rather than publishing a
partial snapshot as complete. Larger logical datasets must be divided into
explicit filtered collections or separate data sources.

Updates carry only the TanStack transaction's changed fields and the values on
which those changes were based. The batch identity query returns each current
page; the server applies non-overlapping fields, skips already-applied values,
and returns structured conflict details rather than overwriting the same
remotely edited property. Identity queries deliberately ignore the collection's
working-set filter: a row that stopped matching the filter still belongs to the
configured data source and must remain discoverable for safe conflict handling.

## Page content flow

Data-source properties remain eager rows. Page bodies are a separate lazy
enhanced-Markdown resource, avoiding an N+1 request at collection startup. A
new offline note stores its body under the stable client key. When configured
with the row collection, the content client observes every row and attaches a
draft as soon as row sync supplies its Notion page ID. This collection-wide
bridge keeps unselected offline drafts from being stranded; applications that
omit the collection must perform the same attachment explicitly.

Editor updates persist immediately and increment a revision. A 750 ms timer
debounces only the remote flush. Each page has one in-flight request; a newer
revision remains pending and sends after the response. The server compares the
draft base to current remote Markdown and retains both versions on conflict.

The UI explicitly watches open page bodies. Only those bodies revalidate on
window focus, a conservative periodic timer, or webhook invalidation; unopened
pages never create an eager N+1 content crawl.

## Known seams

Applications must supply the vendor-specific durable idempotency store and a
shared rate limiter for multi-process deployments. Property conflicts are
field-level, not semantic rich-text merges. Track the remaining work in
[`SHIP_READINESS.md`](SHIP_READINESS.md).
