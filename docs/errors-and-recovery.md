# Errors and recovery

The adapter treats an acknowledged browser mutation as user data. A transient
network or Notion failure keeps that mutation in the durable outbox; it does
not silently roll it back or delete it.

## What the UI should expose

Subscribe to `collection.utils.getSyncState()` and show the storage kind,
online/offline state, pending count, current status, and `progress` while a long
pull or outbox drain is active. Push progress reports completed and total
mutations plus the active batch size; pull progress reports received pages and
rows. Provide controls for:

```ts
await collection.utils.getPendingMutations()
await collection.utils.retryPendingMutation(entryId)
await collection.utils.discardPendingMutation(entryId, {
  acceptDataLoss: true,
})
```

Discard is a data-loss operation and should require a user confirmation. Show
`attempts` and the sanitized `lastError`; do not expose request bodies.

The primary signal that recovery is required is `blockedMutation` from
`useNotionSyncState`:

```tsx
import { useNotionSyncState } from 'tanstack-db-notion-adapter/react'

const sync = useNotionSyncState(collection)
const blocked = sync.blockedMutation

if (blocked) {
  // Render blocked.error.message and offer:
  await collection.utils.retryPendingMutation(blocked.entryId)
  // Or, after confirmation:
  await collection.utils.discardPendingMutation(blocked.entryId, {
    acceptDataLoss: true,
  })
}
```

It contains the FIFO head entry ID and a sanitized `NotionOutboxError` only
when that failure is non-retryable. It is `null` for retryable failures and
clears after retry or discard. A mutation's `tx.isPersisted` promise resolves
when the local durable outbox accepts it; it does not mean Notion accepted the
write, and server rejection does not roll the transaction back.

If the blocked error is `page_not_found`, the row may have been deleted in
Notion while a local edit was pending. Resolve that head entry either by
recreating the page from the pending local value or by explicitly discarding
the local row:

```ts
await collection.utils.resolveDeletedMutation(blocked.entryId, {
  action: 'recreate',
})

await collection.utils.resolveDeletedMutation(blocked.entryId, {
  action: 'discard',
  acceptDataLoss: true,
})
```

Recreation preserves the row's Client ID and uses the normal idempotent insert
path. Only the FIFO head can be resolved, and multi-mutation entries must be
split or retried rather than partially transformed.

## Error classes

- `unauthorized` / HTTP 401 or 403: restore the application session. Keep the
  local outbox intact.
- `schema_mismatch`: run `doctor`, `pull`, or `push --dry-run`; compare stable
  property IDs before changing data.
- `property_conflict`: show each field's base, local, and remote value. Let the
  user choose, then retry from refreshed state or explicitly discard.
- `page_content_conflict`: keep both Markdown bodies. Accept the remote copy or
  explicitly overwrite with `acceptDataLoss: true`.
- `page_content_incomplete`: leave replacement disabled. Implement a targeted
  block-API editor for the unsupported content.
- `notion_query_result_limit`: Notion truncated a query at 10,000 matching
  pages. Narrow the handler's fixed filter or split the logical source into
  explicit collections; never treat the partial result as complete.
- `storage_revision_conflict`: another tab or writer won the local compare-and-
  set. Reload state under the collection lock and retry.
- storage unavailable: reject mutations unless the app intentionally enabled
  lossy memory fallback.
- quarantined persisted state: preserve it for inspection or migration. Clear
  it only with `discardQuarantinedState({ acceptDataLoss: true })`.

## Operational recovery order

1. Stop issuing new edits if corruption or schema drift is suspected.
2. Inspect sync state, pending entries, quarantine metadata, and sanitized
   server events.
3. Restore auth, connectivity, schema, rate-limit capacity, or storage.
4. Retry the oldest failed entry. FIFO ordering prevents later writes for the
   row from passing it.
5. Verify the remote row, then allow the remaining outbox to flush.
6. Discard only after preserving any value the user still needs.

Do not call `resetLocalCache()` as a generic fix while pending mutations exist.
It is appropriate only after the remote source is known complete and losing
local-only data is acceptable.

## Crash and lost-response behavior

Browser persistence resolves on IndexedDB transaction completion. The server
checkpoints batches, individual mutations, and stable insert identities in the
configured idempotency store. A crash can therefore cause a safe replay, but an
acknowledged edit must not silently disappear. The Notion client-ID query also
recovers an insert when Notion created the page but its response was lost.
