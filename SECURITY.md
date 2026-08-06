# Security

The core data-reliability invariants are implemented, but deployment and
browser-support boundaries remain in
[`docs/SHIP_READINESS.md`](docs/SHIP_READINESS.md). Review them before using
sensitive production data.

## Protect the sync endpoint

The Notion token belongs only in a server runtime or local CLI process. The
browser collection receives an application endpoint, never a token.

`createNotionSyncHandler` requires an `authorize` callback unless a local
prototype explicitly sets `dangerouslyAllowUnauthenticated: true`. Authorization
must verify that the caller may access the configured data source; login alone
is not enough. Cookie-authenticated applications must also apply their normal
CSRF protections.

The handler also requires a durable `idempotencyStore` shared by every server
instance. `dangerouslyAllowEphemeralIdempotency: true` uses process memory and
is only appropriate for localhost examples. A production store must serialize
concurrent keys, reject payload-fingerprint reuse, retain successful results
across restarts, and avoid logging mutation bodies.

The handler bounds mutation bodies, validates rows, times out Notion calls, and
sanitizes unexpected errors. Keep framework logs and observability hooks from
recording request bodies or authorization headers.

## Token choice

Personal access tokens act with the creator's workspace permissions and are
appropriate for local/personal workflows. Public or multi-user applications
should use Notion OAuth and store tokens per authorized account. Grant only the
capabilities and workspace access the application needs.

## Browser data

Rows, page bodies, and acknowledged pending edits are stored in IndexedDB (or
localStorage fallback) and are readable by code running in the same origin.
The adapter does not encrypt them. Use a separate origin, content-security
policy, and an application-specific encrypted storage implementation when the
data requires it. Notion-hosted file URLs expire and are not durable offline
media.

If durable browser storage is unavailable, the default storage rejects writes.
Memory fallback is opt-in and can lose edits on reload.

An application may remember that a device was previously authenticated so its
app shell can open offline through a service worker. That is an application
policy rather than an adapter feature: document it clearly, never retain the
password, honor an explicit server rejection, and clear the marker plus
account-scoped caches when identities change.

## Reporting a vulnerability

Do not file an issue containing tokens, private Notion content, or an exploit
against a live workspace. Use the repository host's private security-advisory
channel. Include a minimal reproduction with synthetic data and the affected
package version.
