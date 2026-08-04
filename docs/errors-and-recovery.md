# Errors and recovery

The adapter treats an acknowledged browser mutation as user data. A transient
network or Notion failure keeps that mutation in the durable outbox; it does
not silently roll it back or delete it.

## What the UI should expose

Subscribe to `collection.utils.getSyncState()` and show the storage kind,
online/offline state, pending count, and current status. Provide controls for:

```ts
await collection.utils.getPendingMutations()
await collection.utils.retryPendingMutation(entryId)
await collection.utils.discardPendingMutation(entryId, {
  acceptDataLoss: true,
})
```

Discard is a data-loss operation and should require a user confirmation. Show
`attempts` and the sanitized `lastError`; do not expose request bodies.

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
