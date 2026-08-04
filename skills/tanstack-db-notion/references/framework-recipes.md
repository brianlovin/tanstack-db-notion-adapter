# Framework endpoint recipes

The handler accepts a Web `Request` and returns a Web `Response`. In every
framework, keep the token import and handler in a server-only entry point.

## Hono

```ts
const sync = createNotionSyncHandler(config)
app.all('/api/items', (context) => sync(context.req.raw))
```

## Next.js App Router

```ts
const sync = createNotionSyncHandler(config)
export const GET = sync
export const POST = sync
export const OPTIONS = sync
```

For a public read-only feed, state that policy on the handler rather than
providing mutation idempotency infrastructure:

```ts
const sync = createNotionSyncHandler({
  token: process.env.NOTION_PAT!,
  dataSourceId: process.env.NOTION_DATA_SOURCE_ID!,
  schema: feedSchema,
  readOnly: true,
  authorize: () => true,
  sorts: [{ field: 'publishedAt', direction: 'descending' }],
})
```

The handler rejects `POST` with `405`. A public endpoint still needs normal
rate limiting, cache policy, and an explicit decision that every mapped field
is safe to expose.

## TanStack Start or standard Fetch server

Call the handler from the route's server function with its native `Request` and
return the resulting `Response` unchanged.

## Authorization checklist

- Authenticate before any schema, list, content, or mutation operation.
- Authorize access to the configured data source, not merely login status.
- Keep CSRF protection appropriate to cookie-authenticated POST routes.
- Return a custom `Response` from `authorize` for framework-specific 401/403
  behavior.
- Never derive a data source ID directly from an untrusted browser request
  without checking it against the authenticated user.
