# Sync invariants and failure boundaries

## Acknowledgement

“Persisted” means the normalized mutation is in a durable local outbox, not
that Notion has accepted it. IndexedDB durability occurs at transaction
completion. Request success may precede transaction abort and is insufficient.

The mutation becomes visible in TanStack DB's synced base only after the same
durable commit. A failed queue save rejects the TanStack transaction and leaves
no phantom base row.

Persisted envelopes are versioned. Known older versions migrate under the same
cross-context lock before new work is accepted. Unknown or malformed state is
quarantined with its original value and blocks writes until explicitly handled.

Browser writers use Web Locks when available or a renewable IndexedDB lease
with a fencing token otherwise. State commits increment a revision with atomic
compare-and-set, so an expired or stale lease cannot overwrite a newer outbox.

## Remote acknowledgement

After Notion responds, removal of the outbox head and authoritative returned
row are one local checkpoint. If that checkpoint fails, the old durable head
remains and is retried idempotently. Later pending mutations overlay the
returned row so an older response cannot hide newer local intent.

A successful write does not require a complete collection pull. With webhook
invalidation enabled, the server returns the version observed before the batch
and the version after recording the batch's event. The client advances through
that checkpoint only when it had already observed the first version and the
transition contains no interleaved event. A gap triggers reconciliation, so an
unrelated remote edit cannot be acknowledged accidentally.

Server handlers require a durable idempotency store or an explicit local-only
escape hatch. Batch results and individual mutation results use separate keys.
This prevents duplicates across handler instances, lost client responses, and
partial batches. Reusing a key with another payload is a conflict.

## Pulls

Initial and integrity pulls accumulate every remote page in a temporary map.
Publish and checkpoint only after pagination completes without a repeated
cursor or transport failure. Overlay every pending outbox entry in order before
publication.

A first eager hydration may publish additive page checkpoints before the scan
finishes. Those checkpoints keep `lastSyncedAt` unset and never remove a local
row. A failed scan therefore leaves useful but explicitly incomplete data. A
retry starts from the first remote page, and only its final complete snapshot
may delete rows from the bootstrap. Later refreshes with an already complete
snapshot remain atomic.

Routine catch-up queries use an inclusive Notion `last_edited_time` watermark,
merge returned rows into the local replica, and advance to the greatest remote
timestamp observed. Inclusive filtering deliberately repeats rows at the
watermark so equal millisecond timestamps cannot be skipped. Catch-up cannot
observe a page that was trashed or stopped matching a fixed filter, so explicit
sync and the periodic full reconciliation remain the deletion and membership
integrity mechanism.

For progressive read-only collections, the unit of consistency is the loaded
window. Initial sync fetches one page. `loadMore` commits the next page, cursor,
and page count together. Refresh rebuilds every previously loaded page from the
first page before publishing, so remote reordering and deletion cannot produce
gaps or duplicates inside the window. Offline hydration restores both rows and
the pagination checkpoint. Mutable collections cannot use progressive sync.

## Errors and recovery

Record attempt count, time, code, status, and retryability on the failed head.
Keep it FIFO. Retry after correcting the cause. Discard only while online with
`acceptDataLoss: true`, then refresh the remote snapshot.

## Property conflicts

An update contains the changed fields, their base values, and the full intended
row. The server compares only those fields with the current Notion page. Remote
changes to other properties survive. If the same property differs from both
the base and intended value, no patch is sent and `property_conflict` includes
the base, local, and remote values for explicit recovery.

## Content revisions

Save editor revisions locally before resolving `update`. Debounce network only.
Allow one in-flight content write per page. If a newer revision appears, use the
acknowledged remote body as its next base and flush again. If Notion no longer
matches the original base, preserve both strings and require an explicit
resolution.

## Regression locations

- `tests/browser-storage.test.ts`: request-success/transaction-abort boundary,
  lease serialization, and stale-revision fencing.
- `tests/client.test.ts`: queue/checkpoint failures, FIFO, overlays, recovery,
  migrations, quarantine, progressive pagination/offline hydration, structured
  conflicts, and large transactions.
- `tests/server.test.ts`: endpoint trust boundary, request limits, Notion CRUD,
  concurrent handlers, partial batches, lost responses, property merges,
  source scoping, and Markdown conflicts.
- `tests/content-client.test.ts`: debounce, in-flight edits, reload recovery,
  offline page attachment, and content conflicts.
