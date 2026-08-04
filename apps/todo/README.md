# Daylight

Daylight is the production-oriented acceptance app for the TanStack DB Notion
adapter: a fast, keyboard-friendly personal task manager with Notion as its
source of truth. It is intentionally Things-inspired in interaction quality,
but uses its own visual identity and does not copy Cultured Code assets or
branding.

It proves the product shape this adapter is optimized for: authenticated,
mutable, offline-capable personal or small-team applications—not a public,
read-heavy publishing cache.

## What it exercises

- Eager local materialization and instant TanStack DB views.
- Durable optimistic insert, edit, complete, reorder, and trash operations.
- Inbox, Today, Upcoming, Anytime, Someday, Logbook, and All views.
- Quick entry tokens: `@today`, `@tomorrow`, `@inbox`, `@anytime`, `@someday`,
  and `!high` / `!medium` / `!low`.
- A virtualized task list designed to stay responsive across thousands of rows.
- Lazy, durable page-body notes with a 750 ms remote debounce.
- Offline PWA shell, cached collection hydration, reload-safe outbox recovery,
  and explicit sync/error state.
- Password/session auth, same-origin writes, a durable SQLite idempotency ledger,
  shared in-process Notion rate limiting, webhook invalidation, and sanitized
  request metrics.

## Connect a Notion source

Daylight's checked-in [`notion.schema.json`](./notion.schema.json) expects these
properties:

| Field           | Notion property | Type                            |
| --------------- | --------------- | ------------------------------- |
| Stable key      | Client ID       | Rich text                       |
| Title           | Name            | Title                           |
| Area            | List            | Select: Inbox, Anytime, Someday |
| Scheduled date  | When            | Date                            |
| Deadline        | Due             | Date                            |
| Priority        | Priority        | Select: Low, Medium, High       |
| Ordering        | Position        | Number                          |
| Completion      | Done            | Checkbox                        |
| Completion date | Completed At    | Date                            |

Use a dedicated source or first review the dry run against an existing one.
From the repository root:

```sh
npm run build
cp apps/todo/.env.example apps/todo/.env
# Fill server-only values in apps/todo/.env
cd apps/todo
vp install
vp exec node ../../dist/cli.js doctor \
  --env .env --manifest notion.schema.json
vp exec node ../../dist/cli.js push --dry-run \
  --env .env --manifest notion.schema.json
```

Only run the real `push` after reviewing the exact operations:

```sh
vp exec node ../../dist/cli.js push \
  --env .env --manifest notion.schema.json \
  --out src/todo-schema.generated.ts
```

Never put the token in a `VITE_` variable. `NOTION_ENV_FILE` may point at an
existing server env file without copying the secret.

## Develop and verify

Install with Node 22.13 or newer. Vite+ is a local development dependency, so
you do not need a global `vp` command:

```sh
npm install
npm run dev
npm run check
npm test
npm run build
```

The dev server runs the Hono API as middleware at
[http://localhost:5174](http://localhost:5174). Keyboard shortcuts:

- `Command/Ctrl N`: new task
- `Command/Ctrl K`: focus quick entry
- `Command/Ctrl 1` through `Command/Ctrl 7`: switch views
- Up/Down: move the selected task
- Escape: close quick entry, inspector, or mobile navigation

## Run the production server

Build, disable the development auth bypass, and provide strong random auth
values:

```sh
npm run build
NODE_ENV=production npm run serve
```

If you already use the global Vite+ environment manager, the equivalent direct
commands are `vp dev`, `vp check`, `vp test --run`, and `vp build`.

Required production environment:

```dotenv
NOTION_PAT=server-only-value
NOTION_DATA_SOURCE_ID=exact-data-source-id
APP_PASSWORD=long-private-password
SESSION_SECRET=at-least-32-random-bytes
DEV_BYPASS_AUTH=false
WEB_ORIGIN=https://tasks.example.com
DATA_DIRECTORY=/durable/daylight-data
```

The Node process serves the static PWA and API from one origin. Mount
`DATA_DIRECTORY` on durable single-region storage. The bundled SQLite WAL store
coordinates multiple processes on that host, but it is not a networked
multi-region idempotency service. Replace it with a shared implementation before
horizontal/serverless deployment. The in-memory limiter and invalidation store
have the same single-process boundary.

Set `NOTION_WEBHOOK_VERIFICATION_TOKEN` after completing Notion webhook setup.
Keep the normal 60-second data poll: webhooks reduce latency but are not the
sync durability boundary.

## Offline and privacy contract

An authenticated device remembers only that it was previously unlocked so the
installed PWA can start when the session endpoint is unreachable. It does not
store the password or session cookie in application storage. An HTTP 401 still
locks the app; a network-level failure may open the locally cached workspace.
This means anyone with access to the same unlocked browser profile can read its
IndexedDB cache. Use device encryption and a dedicated OS/browser account for
sensitive tasks.

Task properties and page bodies persist locally. Notion-hosted file URLs are not
durable offline media. Logout clears the remembered-device marker; production
deployments that share a browser between people should also add an explicit
local-cache purge policy.

## Current release boundary

The core reliability path has automated tests and has been exercised against a
real Notion source for online create/edit/content/delete and offline
edit/reload/reconnect recovery. Before treating Daylight as a general hosted
multi-user product, add Notion OAuth, a distributed idempotency/limiter/
invalidation backend, encrypted token storage, account-scoped cache clearing,
and a Chromium/Firefox/WebKit browser matrix.
