# Durable idempotency stores

`createNotionSyncHandler` requires one of two explicit policies:

- `idempotencyStore`: production. Share one durable implementation across every
  process and serverless instance that can write to the data source.
- `dangerouslyAllowEphemeralIdempotency: true`: localhost only. Results vanish
  when the process exits and cannot coordinate separate processes.

The store implements one operation:

```ts
interface NotionIdempotencyStore {
  execute<T>(
    operation: {
      scope: string
      key: string
      fingerprint: string
    },
    run: () => Promise<T>,
  ): Promise<T>
}
```

## Required semantics

For each `(scope, key)` pair, an implementation must:

1. Serialize concurrent callers across every server instance.
2. Reject a different fingerprint with `NotionIdempotencyConflictError`.
3. Run the callback at most once at a time.
4. Persist a successful JSON-compatible result before returning it.
5. Replay that result to later callers, including after a process restart.
6. Release or expire an unfinished claim after a failed callback; never cache a
   failure as success.

The adapter passes SHA-256 fingerprints rather than raw mutation bodies. Store
the fingerprint and result, but do not log either. Results can contain synced
row values and must receive the same privacy controls as application data.

The handler checkpoints the whole batch, each mutation within the batch, and
the stable client ID of each insert. The final identity checkpoint prevents two
different browser transactions from concurrently creating the same row.

## Backend guidance

A PostgreSQL implementation can use a unique `(scope, key)` row plus an
ownership lease or advisory lock, then commit the fingerprint and JSON result
in a transaction. A Redis implementation needs an atomic claim, owner-checked
renewal/release, and a durable result value. A single-region Durable Object or
equivalent serialized actor can implement the same contract directly.

Do not implement `execute` as `get`, run, then `set`; that recreates the race the
store is intended to remove.

Use `createMemoryNotionIdempotencyStore()` only for tests and one-process local
examples. It is useful for contract testing multiple handlers that share the
same instance, but it is intentionally not durable.

## Single-host SQLite example

The package includes a copyable Node SQLite implementation in
[`sqlite-idempotency-store.ts`](sqlite-idempotency-store.ts). It uses
a unique `(scope, key)` row, `BEGIN IMMEDIATE` ownership election, WAL with full
synchronous durability, renewable leases, fingerprint collision rejection,
and committed result replay. The repository test suite covers two independent
store instances racing for the same operation.

This is appropriate for one durable host whose processes share the same local
database file. It is not appropriate for ephemeral/serverless filesystems or
hosts that do not share a disk. Use PostgreSQL, Redis with durable result
storage, or a serialized cloud actor for those deployments.
