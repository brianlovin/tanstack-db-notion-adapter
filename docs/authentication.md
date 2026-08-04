# Authentication and tenancy

The adapter deliberately separates browser access from Notion credentials:

```text
browser session → application authorization → sync handler → Notion token
```

The browser receives only an application endpoint. Do not use a `VITE_`,
`NEXT_PUBLIC_`, or other client-exposed environment variable for the token.

## Personal and single-workspace applications

A Notion personal access token is a good fit for a private tool owned by the
same person as the workspace. Run it only on the server and protect the sync
endpoint with application authentication. The Daylight app demonstrates a
password-gated, signed, `HttpOnly`, `SameSite=Strict` cookie and rejects
cross-origin writes. Its `DEV_BYPASS_AUTH` mode is refused in production.

The authorization callback must answer both questions:

1. Is this request authenticated?
2. May this identity access this configured data source?

Login alone is not enough when a server can reach more than one user's data.

## Multi-user products

Use Notion OAuth and retain one encrypted server-side token per authorized
Notion account or workspace. Resolve the requested data source from a
server-side allowlist owned by that identity; never accept an arbitrary source
ID from the browser and combine it with a privileged token.

OAuth token lifecycle and account provisioning are intentionally outside this
adapter today. The sync handler accepts the already-authorized token and source
for one request boundary.

## Required production controls

- Supply `authorize`; never enable `dangerouslyAllowUnauthenticated`.
- Supply a durable idempotency store shared by every process that can write.
- Apply normal CSRF protection to cookie-authenticated mutation routes.
- Rate limit login and public endpoints in addition to the Notion-aware request
  scheduler.
- Keep tokens, authorization headers, mutation bodies, and page content out of
  logs and telemetry.
- Use a restrictive content-security policy and a dedicated origin for private
  offline data.
- Clear local collection and page-content caches on account changes or logout
  when another person could use the same browser profile.

The package authorizes one configured source; application account management,
session revocation, OAuth storage, and per-user source discovery remain the
host application's responsibility.
