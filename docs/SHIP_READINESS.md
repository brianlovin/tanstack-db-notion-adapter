# Ship-readiness roadmap

This document is the working backlog for taking the adapter from a proof of
concept to a package that can safely hold real user data. Keep it current as
work lands: check completed items, link the test that protects each invariant,
and record scope decisions under **Decision log**.

## Product promise

A developer can point the adapter at an existing or evolving Notion data
source, generate a checked-in type-safe schema, and build an instant,
offline-capable TanStack DB application without exposing Notion credentials to
the browser or losing acknowledged edits.

All P0 invariants are implemented and protected by regression tests. The
package is a release candidate for its focused single-user/small-team use case;
the unchecked browser, live-Notion, and distributed-deployment gates below are
required before claiming universal production support.

## Non-negotiable sync invariants

- [x] **INV-01 — Durable acknowledgement.** A TanStack DB mutation handler only
  resolves after the mutation can survive a reload. IndexedDB completion—not
  request success—is the durability boundary.
- [x] **INV-02 — No acknowledged mutation is lost.** A crash or exception at
  any load, append, save, request, response, dequeue, or checkpoint boundary
  may cause an idempotent retry, but never silent loss.
- [x] **INV-03 — Snapshot atomicity.** A failed later page in a paginated pull
  does not replace the last complete local snapshot. Covered by the existing
  paginated sync contract test.
- [x] **INV-04 — Pending writes win locally.** A pull overlays the entire local
  outbox so stale remote state cannot make an acknowledged offline edit
  disappear.
- [x] **INV-05 — Idempotent inserts.** Lost responses, retries, multiple tabs,
  and concurrent server instances cannot create duplicate pages for one client
  ID. Production handlers require a durable shared execution ledger; batches
  and individual mutations are checkpointed separately.
- [x] **INV-06 — Stable schema identity.** Reads, writes, validation, and schema
  generation prefer Notion property IDs so display-name changes are safe.
- [x] **INV-07 — Ordered mutations.** Mutations for the same record reach Notion
  in order; retry or dead-letter handling cannot reorder them accidentally.
- [x] **INV-08 — Dry runs are inert.** `push --dry-run` sends no schema mutation
  request and changes no local generated or manifest files.
- [x] **INV-09 — Clean shutdown.** Collection cleanup removes timers, browser
  listeners, locks, and broadcast channels and prevents later writes.
- [x] **INV-10 — Token isolation.** Notion credentials are accepted by the
  server package and CLI only, never by the browser collection options.

## Current sprint: durability before features

### P0.1 — Browser persistence

- [x] Wait for `IDBTransaction.oncomplete` before resolving a read or write.
- [x] Add an abort-after-request-success regression test.
- [x] Add `fake-indexeddb` round-trip tests for cached rows and outbox entries.
- [x] Persist a queued mutation before publishing it into the collection's
  synced base state.
- [x] Add fault-injection tests for storage failures at queue and dequeue
  boundaries.
- [x] Version the persisted envelope and migrate or quarantine old/invalid
  cache and outbox data explicitly.
- [x] Define a durability policy for browsers where only in-memory fallback is
  available; do not silently claim offline durability.

Acceptance criteria: a storage transaction that aborts after its object-store
request succeeds cannot cause the mutation handler to resolve early; a rejected
save cannot leave a phantom acknowledged row in the synced base state.

### P0.2 — Endpoint safety

- [x] Add a required authorization decision to the server handler, with an
  explicit development-only escape hatch.
- [x] Enforce request body and mutation batch size limits before JSON decoding
  or Notion calls.
- [x] Add Notion request timeouts and `AbortSignal` propagation.
- [x] Retry only retryable failures using capped exponential backoff with
  jitter and `Retry-After` support.
- [x] Redact tokens, request bodies, and user content from package errors.
- [x] Add contract tests for authorization, malformed input, oversized input,
  timeout, cancellation, rate limiting, and sanitized errors.

Acceptance criteria: the default production configuration cannot expose an
unprotected Notion write proxy, and a slow or hostile request has bounded
resource use.

### P0.3 — Outbox and concurrency

- [x] Chunk TanStack DB transactions larger than the server batch limit while
  preserving order and atomic local acknowledgement.
- [x] Record attempts and last error for pending operations.
- [x] Add inspect, retry, and discard APIs so one poison mutation does not make
  the application permanently unusable.
- [x] Require explicit confirmation before discarding an acknowledged edit.
- [x] Coordinate browser writers when Web Locks is unavailable (IndexedDB
  lease/CAS or a single-writer strategy).
- [x] Make insert idempotency durable across server instances. Production
  handlers require a shared durable execution ledger; query-by-client-ID also
  recovers a lost response from Notion itself.
- [x] Specify conflict behavior. Updates serialize changed properties only,
  merge unrelated remote edits, and reject overlapping fields with structured
  base/local/remote values.
- [x] Resolve property conflicts by row and field under the collection lock,
  rebase later pending values, and preserve partially applied batch work.
- [x] Add multi-tab, lost-response, concurrent-insert, poison-entry, and FIFO
  regression tests.
- [x] Persist transaction-level remote receipts across bounded chunks and allow
  atomic cancellation only before remote delivery begins.

Acceptance criteria: no batch size, bad entry, tab count, process restart, or
lost response can silently lose an acknowledged edit or create a duplicate.

## P1 — Complete and ergonomic schema support

### Property fidelity

- [ ] Cover every official Notion property type in fixtures and in
  [`PROPERTY_SUPPORT.md`](./PROPERTY_SUPPORT.md).
- [x] Preserve annotations, mentions, links, and equations for title/rich text
  instead of flattening them to plain strings when developers opt into a rich
  representation.
- [x] Preserve date `end` and `time_zone`.
- [x] Paginate the page-property endpoint when a page response truncates a
  title, rich text, people, or relation value after 25 references.
- [x] Represent future unknown property types explicitly instead of omitting
  them during introspection.
- [x] Decide supported read/write representations for people, files, relation,
  formula, rollup, unique ID, place, verification, created-by, and edited-by.
- [ ] Test wiki data sources separately from ordinary data sources.

### Schema workflow

- [x] Publish JSON Schema for `notion.schema.json` and validate manifests before
  generation or network access.
- [x] Reject invalid TypeScript identifiers and generated-name collisions with
  actionable diagnostics.
- [x] Make generated-file and manifest writes atomic and deterministic.
- [x] Preserve developer field ordering on pull to avoid noisy diffs.
- [x] Extend drift detection beyond name/type/select-option names: number
  format, descriptions, colors, status groups, formulas, relations, and
  rollups must be either compared or documented as intentionally unmanaged.
- [x] Rename `--allow-destructive` to the familiar `--accept-data-loss` and keep
  a deprecation path if the former has shipped.
- [x] Add `--help`, `--version`, `doctor`, and links to the affected Notion data
  source in command output.
- [x] Generate insert types that omit read-only fields rather than making them
  optional.
- [x] Add compile-time inference tests for generated schemas and codec input/
  output behavior.

### Multi-data-source databases

- [x] Accept an exact data source ID.
- [x] Resolve a database ID automatically when it has one data source.
- [x] Refuse an ambiguous database ID instead of choosing silently.
- [x] List data source names and IDs in the ambiguity error and CLI.
- [x] Add a flag-driven data source selector using the exact `--id` value.
- [ ] Run two collections against two sources in one database in a contract
  test and share rate-limit coordination between them.
- [ ] Type relations between sources where the target schema is known.

## P2 — Scale, operations, and distribution

- [x] Replace per-handler rate limiting with a shared/pluggable limiter suitable
  for serverless and multi-process deployments.
- [x] Coalesce insert reconciliation into one client-ID query per mutation
  batch, while preserving durable per-key idempotency and lost-response
  recovery.
- [x] Coalesce update and delete identity/conflict reads into the same
  data-source-scoped batch query and reject mismatched client-supplied page IDs.
- [x] Expose pull and outbox-drain progress, use bounded default client batches,
  and document redacted per-request telemetry for production measurement.
- [x] Reject Notion's incomplete 10,000-result response instead of publishing a
  silently truncated collection snapshot.
- [x] Add webhook-assisted invalidation while retaining polling as recovery.
- [x] Offer progressive materialization for large read-only sources, with an
  atomic persisted page/cursor checkpoint and loaded-window refresh. Eager
  mutable collections publish additive pages during first hydration while
  retaining a complete-snapshot requirement. Permanently partial mutable
  snapshots remain out of scope.
- [x] Persist an inclusive `last_edited_time` watermark for changed-row catch-up
  and retain periodic complete snapshots for deletion and filter-membership
  integrity.
- [ ] Retain page-level webhook tombstones before claiming immediate deletion
  convergence without complete snapshots.
- [ ] Define an explicit partition cursor and merge contract before representing
  more than 10,000 matching Notion pages as one logical collection.
- [x] Skip unchanged collection updates during refresh.
- [ ] Add OAuth for multi-user/public products; personal access tokens remain a
  developer and personal-workspace workflow.
- [x] Document cache privacy and provide a custom-storage/encryption hook for
  sensitive sources.
- [x] Namespace collection rows, outboxes, page content, quarantines, and
  browser coordination by an immutable account/workspace storage scope.
- [x] Define offline media behavior because Notion-hosted file URLs expire.
- [x] Add structured observability hooks without logging content or secrets.
- [x] Declare `@tanstack/db` as a compatible peer (`^0.6.17`), test against
  exact `0.6.17`, and assert a packed consumer installs one collection runtime.
  Additional framework/build-tool versions remain a distribution-test backlog.

## Clean-room integration audit

A separate agent built a journal from the published docs and a packed tarball,
then verified schema evolution, typed CRUD, page bodies, offline reload,
property renames, conflicts, and durable SQLite idempotency against live Notion.

- [x] Accept a pasted Notion database URL and document
  `resolveNotionDataSourceId()`.
- [x] Gate collection and page-content auto-sync until browser authentication
  is ready, while still hydrating durable local state.
- [x] Warn before `push` adds the visible stable client-ID property.
- [x] Provide a pasteable localhost handler and document the single GET/POST
  route protocol plus production policy replacements.
- [x] Document the generated input/update-draft type and the complete page-body
  `createDraft` / `load` / `attachPage` lifecycle.
- [x] Prove persisted content failures clear and retry after client recreation.
- [x] Ship the tested SQLite idempotency reference linked by the package docs.
- [x] Preserve `$schema`, remove duplicate option config, and distinguish drift
  output from the inert push dry run.
- [x] Document that offline data hydration does not cache the host app shell.
- [ ] Publish the verified package to npm and repeat the clean install from the
  registry rather than a tarball.

A second Next.js clean-room build repeated the live schema, CRUD, Markdown,
offline outbox, delete, and IndexedDB journeys, then identified these follow-up
integration gaps:

- [x] Accept `app.notion.com` Copy-link URLs as well as legacy Notion hosts and
  bare IDs.
- [x] Observe the full row collection from the page-content client so an
  unselected offline draft is attached and flushed when its row receives a
  Notion page ID.
- [x] Create content drafts before row insertion in the README and Notes
  example, and define `attachPage` versus the lower-level `load` operation.
- [x] Ship optional React hooks with stable server snapshots for sync state and
  page content.
- [x] Document that `useLiveQuery` UI in Next.js App Router needs a separate
  client-only dynamic wrapper.
- [x] Document polling defaults and the current optional-field limitation of
  TanStack DB update drafts.
- [x] Revalidate only actively watched page bodies on focus, a conservative
  timer, or webhook invalidation so direct Notion edits appear without an N+1
  content crawl.
- [x] Expose normalized page-content editability, read-only reasons, and
  conflict choices so editors do not have to reconstruct safety rules.
- [x] Surface incremental versus full reconciliation freshness and provide an
  explicit `fullReconcileNow()` operation.

## Test program

### Every pull request

- [ ] Unit fixtures for every property codec, including malformed and unknown
  Notion payloads.
- [x] Compile-time tests using `expectTypeOf` or a dedicated type-test project.
- [x] HTTP contract tests with a scripted Notion transport.
- [x] IndexedDB persistence and fault-injection tests.
- [ ] Model-based outbox tests (for example, `fast-check`) over mutation,
  failure, reload, and reconciliation sequences.
- [ ] CLI snapshots plus assertions about requests and filesystem effects.
- [x] `npm pack` install smoke test that imports browser, server, schema-tools,
  and CLI entry points without leaking server code into a browser bundle.

### Browser matrix

- [ ] Playwright Chromium, Firefox, and WebKit offline/reload coverage.
- [ ] Two-tab editing, tab close during flush, lock fallback, quota failure, and
  private-browsing/storage-unavailable scenarios.
- [ ] Prove that source maps and built browser chunks contain no configured
  token.

### Gated live Notion suite

- [ ] Create or reset a temporary data source for each run.
- [ ] Exercise schema pull/dry-run/push/check, CRUD, pagination, rename-by-ID,
  rate-limit retry, page-property pagination, and all writable property types.
- [ ] Run on demand and nightly rather than for untrusted pull requests.
- [ ] Clean up test pages without ever targeting a broad workspace location.

### Performance budgets

- [ ] Record startup hydration, refresh, query, and mutation latency for 1,000
  and 10,000 cached rows.
- [ ] Bound IndexedDB writes and collection operations per remote refresh.

## Documentation and coding-agent support

- [x] `README.md`: honest quick start, support status, and production warning.
- [x] `SECURITY.md`: endpoint authentication, token isolation, browser cache,
  PAT/OAuth guidance, disclosure process.
- [x] `AGENTS.md`: repository commands, ownership boundaries, generated-file
  rules, and non-negotiable invariants.
- [x] `docs/architecture.md`: browser/server/Notion trust boundaries and state
  machine.
- [x] `docs/sync-invariants.md`: crash points, acknowledgement semantics,
  conflicts, and recovery.
- [x] `docs/schema-workflow.md`: existing-source and code-first workflows.
- [x] `docs/authentication.md`, `docs/errors-and-recovery.md`, and
  `docs/large-datasets.md`.
- [ ] Framework recipes for Hono, TanStack Start, Next.js, Workers, Bun, and a
  standard Node server.
- [x] One portable Agent Skill under `skills/tanstack-db-notion/` with a short
  `SKILL.md`, progressive references, and a read-only `doctor` script.
- [x] The skill instructs agents to keep tokens server-only, inspect the package
  version and manifest, dry-run before push, ask before data loss, select exact
  data sources, edit the manifest rather than generated output, consult the
  property matrix, protect the endpoint, and run offline regression tests.

## Example applications

Examples are intentionally thin acceptance tests for product workflows. Their
Notion-style interface uses a small type scale, neutral colors, and only the
controls needed to exercise the adapter behavior under test.

### Todos (existing)

- [x] Generated schema from a checked-in manifest.
- [x] Instant optimistic CRUD and eager offline cache.
- [x] PAT and single-source database-ID setup.
- [x] Surface blocked outbox recovery and storage durability status in the UI.
- [ ] Add Playwright offline/reload coverage.

### Notes / journal (implemented proof of concept)

The Notes example is a two-pane list and editor. It keeps the page-content
lifecycle visible without adding application-specific navigation or styling.
On narrow screens the panes become separate views with a Back control.

- [x] Use Notion's enhanced-Markdown API in version `2026-03-11`, retaining the
  block API as a future fallback for unsupported block types.
- [x] Keep root-page metadata in the normal data-source collection.
- [x] Load selected page contents lazily to avoid an N+1 request for every row.
- [x] Cache content by stable client key, then attach the Notion page ID after a
  brand-new offline row reaches the server.
- [x] Persist each local editor draft immediately, while coalescing remote
  content writes and flushing after an idle debounce (initial target: 750 ms),
  on blur, on page switch, and before unload when feasible.
- [x] Keep one in-flight write per page; if editing continues during a request,
  schedule the newest revision rather than sending every intermediate state.
- [x] Show separate local-save, pending-sync, offline, conflict, and error
  states; never label a local-only draft as synced.
- [x] Recover drafts after reload and expose retry plus explicit conflict
  resolution for a rejected page content update.
- [x] Retain local and remote bodies when both changed; require the user to
  accept Notion's copy or explicitly accept data loss before overwriting it.
- [ ] Test fast typing, offline typing, reload during debounce, page switching,
  lost responses, remote edits, content pagination, and large pages.
- [x] Validate the page-content primitive with unit tests for durability,
  debounce/coalescing, lost responses, cleanup, and conflicts plus a real-Notion
  create/edit/reload journey.

### Reliability Lab

- [x] Deterministically migrate a legacy envelope and quarantine an unknown one.
- [x] Force the IndexedDB lease path with two independent collection writers.
- [x] Lose a successful response, retry through another handler instance, and
  verify exactly one remote page.
- [x] Verify unrelated property edits merge and same-property edits produce a
  structured conflict.
- [ ] Repeat the multi-tab journey in the browser automation matrix.

### briOS listening history (production-code proof of concept)

- [x] Map an existing unmodified Notion source by stable property IDs and use
  its synthetic page ID as the read-only collection key.
- [x] Mount a Next.js read-only handler with server-side sorting and PAT kept in
  the existing server environment.
- [x] Replace SWR cursor pages with a typed TanStack DB live query and
  virtualized `loadMore()` flow.
- [x] Prove a cold load fetches one 100-row page, scrolling checkpoints a second
  page, and an API-blocked reload hydrates both pages from IndexedDB.
- [x] Verify desktop and mobile layouts, the read-only `405` boundary, unit
  tests, lint, and the production Next.js build.

### Historical production Todo acceptance sprint

This larger standalone harness was removed after validation so `examples/todos`
remains the repository's single Todo app. Its implementation and browser-test
history remain available in Git.

- [x] Scaffold a standalone Vite+ PWA with its pinned managed toolchain.
- [x] Connect the checked-in generated schema to a real existing Todo data
  source using stable property IDs and an additive reviewed schema push.
- [x] Implement Inbox, Today, Upcoming, Anytime, Someday, Logbook, All, quick
  entry directives, keyboard navigation, virtualized rows, responsive layouts,
  and editable lazy page-body notes.
- [x] Require production auth, same-origin writes, and a durable cross-process
  SQLite idempotency ledger with crash leases and result replay.
- [x] Prove online create/edit/page-content/reload/delete against Notion and
  offline edit/reload/reconnect outbox recovery in a real Chromium journey.
- [x] Prove the production service worker serves the shell, cached task rows,
  and cached page content offline without intercepting `/api`.
- [x] Add unit/component tests for auth, durable SQLite concurrency, remembered
  offline-device policy, clean content loading, view logic, directives, and a
  10,000-row local query/sort workload.
- [ ] Complete automated Firefox/WebKit and installable mobile-device journeys.
- [ ] Replace its single-host memory limiter/invalidation store and SQLite
  ledger before horizontal or serverless deployment.

## Recommended implementation order

1. Persistence fault harness and INV-01/INV-02.
2. Authorization, limits, timeout, and sanitized HTTP errors.
3. Outbox recovery, batching, conflicts, and durable idempotency.
4. Full property and multi-source matrix.
5. Manifest validation and CLI ergonomics.
6. Architecture/security/agent documentation.
7. Lazy page-content primitive and the Notes example.
8. Browser matrix, live Notion suite, packaging matrix, and performance gates.

## Decision log

- **2026-08-03:** Use `push --dry-run` rather than a custom `plan` command so
  the schema workflow follows familiar migration-tool ergonomics.
- **2026-08-03:** A database containing multiple data sources must be resolved
  explicitly. The adapter never guesses.
- **2026-08-03:** Page contents are a lazy resource associated with a page, not
  an eagerly fetched property on every data-source row.
- **2026-08-03:** Editor debounce may delay network flush, but never local
  durability. “Saved locally” and “synced” are distinct states.
- **2026-08-03:** Progressive materialization is read-only. The adapter
  checkpoints rows and cursor together, and refreshes the full loaded window;
  it does not pretend a partial snapshot can safely reconcile local writes.
- **2026-08-04:** Focus the product on authenticated, frequently manipulated
  personal and small-team applications where instant optimistic writes and
  offline continuity matter. Public, read-heavy, slow-changing sites are not
  the primary optimization target.
- **2026-08-04:** Use an eager mutable collection for the Todo acceptance app so
  every task view stays instant and available offline. Virtualize rendering
  rather than weakening the local data model with mutable partial snapshots.
- **2026-08-04:** A previously unlocked device may open the Todo app's local
  cache after a network-level session failure. A real HTTP authorization
  rejection always locks the app, and the privacy implication is documented.
- **2026-08-04:** The Todo app's SQLite idempotency store is a production recipe
  for one durable host, not a distributed default. The package keeps storage,
  limiter, and invalidation backends pluggable.
- **2026-08-06:** Authenticated apps may hydrate immediately but can defer all
  automatic collection and page-content requests with `autoStart: false`, then
  explicitly resume after session restoration.
- **2026-08-06:** One collection never treats Notion's 10,000-result query cap
  as a complete snapshot. Larger sources use explicit disjoint filters or
  separate data sources until safe automatic partitioning has a defined cursor
  and mutable-snapshot model.

## External constraints to keep checking

- [Notion property schema objects](https://developers.notion.com/reference/property-object)
- [Query a data source](https://developers.notion.com/reference/query-a-data-source)
- [Retrieve a page](https://developers.notion.com/reference/retrieve-a-page)
- [Retrieve a page property](https://developers.notion.com/reference/retrieve-a-page-property)
- [Notion request limits](https://developers.notion.com/reference/request-limits)
- [TanStack DB collection option creators](https://tanstack.com/db/latest/docs/guides/collection-options-creator)
- [TanStack DB mutations](https://tanstack.com/db/latest/docs/guides/mutations)
