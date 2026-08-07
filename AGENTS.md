# Repository guide for coding agents

## Commands

```sh
npm run typecheck
npm test
npm run build
npm run build:example
npm run test:package
```

Use `npm run dev` for Todos on ports 5173/8787 and `npm run dev:notes` for
Notes on 5174/8788.

## Releases

Bump `version` in `package.json` and `package-lock.json` in a pull request. When
that pull request reaches `main`, `.github/workflows/publish.yml` runs the full
release check, publishes the exact version if it is not already on npm, and
creates the matching GitHub tag and release. Do not publish releases manually.

## Ownership boundaries

- `src/schema.ts`: codecs and Standard Schema inference.
- `src/client.ts`: TanStack collection lifecycle, durable cache, outbox.
- `src/server.ts`: server-only authorization and Notion transport.
- `src/schema-tools.ts` / `src/cli.ts`: manifest workflow.
- `src/content-client.ts`: lazy durable enhanced-Markdown page bodies.
- `examples/`: acceptance examples, not package internals.

Edit `notion.schema.json`, then regenerate `notion.generated.ts`. Do not
hand-edit generated files. Preserve unrelated working-tree changes.

## Non-negotiable behavior

- Never expose or print Notion tokens. Read env key names only when diagnosing.
- Never mount an unauthenticated production sync handler. The dangerous opt-out
  is for localhost examples.
- Resolve IndexedDB writes on transaction completion, not request success.
- Persist local mutations before publishing them into the synced base state.
- Migrate known persisted envelopes under the collection lock; quarantine
  unknown or malformed state instead of replacing it.
- Preserve the IndexedDB lease fallback and revision compare-and-set when
  changing browser persistence.
- Keep outbox entries FIFO and overlay all pending values on remote snapshots.
- Require a shared durable idempotency store in production server handlers.
  Checkpoint both batches and individual mutations; never weaken the explicit
  ephemeral development escape hatch.
- Serialize only changed properties and retain base/local/remote values for
  overlapping property conflicts.
- Do not drop a failed acknowledged edit automatically. Require
  `acceptDataLoss: true` for discard/overwrite operations.
- Prefer stable Notion property IDs over display names.
- Never guess among multiple data sources in one database.
- Refuse lossy page-content replacement when Markdown is incomplete.
- Keep PWA navigation fallback away from `/api`; an offline shell must never
  turn an API failure into cached HTML.
- Never treat a network-level session failure as an HTTP authorization grant
  unless the host app has an explicit, documented previously-unlocked-device
  policy. A real 401/403 always wins.

Read [`docs/SHIP_READINESS.md`](docs/SHIP_READINESS.md) before declaring the
package production-ready. Add a regression test before fixing a sync invariant.
