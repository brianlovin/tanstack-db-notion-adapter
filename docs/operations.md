# Production operations

## Advanced exports

The root package contains application-facing schema, collection, recovery, and
page-content APIs. Import storage constructors, persistence state and
coordination types, protocol types, and internal page representations from
`tanstack-db-notion-adapter/advanced`.

## Rate limiting

Pass one shared `NotionRateLimiter` to every handler using the same Notion
connection and `rateLimitScope`. `createMemoryNotionRateLimiter()` coordinates
one JavaScript process. Serverless and multi-process deployments need a shared
scheduler backed by infrastructure such as Redis, a durable actor, or a queue.
The handler honors `Retry-After`, capped backoff, and per-request timeouts.
Idempotent requests retry transient failures. Page creation retries explicit
429 throttling responses, but an ambiguous timeout, network failure, or
server error returns to the durable outbox so the next attempt can reconcile by
client ID before creating again.

## Idempotency

Writable production handlers require a durable shared `NotionIdempotencyStore`.
See [the store contract](./idempotency-store.md). The package provides a SQLite WAL
implementation for one durable host with multiple processes; horizontally
scaled deployments should use a shared database or serialized service.

## Webhook invalidation

Configure the same `NotionInvalidationStore` and scope on the sync and webhook
handlers. The webhook handler validates its one-time verification token when
configured and deduplicates event IDs through the store. Browser collections
poll only the cheap invalidation version via `tuning.invalidationPollIntervalMs`, then
refresh data when it changes. Page-content clients use the same option but
revalidate only bodies currently watched by the UI. Keep slower periodic and
focus revalidation as recovery because webhook delivery is not a durability
boundary.

The memory store is for one process. Production needs shared durable versions
and event-ID deduplication.

## Observability

`onEvent` receives structured Notion request telemetry:

- operation and attempt
- success, retry, or error outcome
- duration and HTTP status
- scheduled retry delay

Events never contain tokens, authorization headers, request bodies, property
values, or page content. Attach request IDs and deployment metadata in the host
application, and aggregate rates and latency rather than copying user data into
logs.

```ts
// server/notion-telemetry.ts
import type { NotionServerEvent } from 'tanstack-db-notion-adapter/server'

const counts = new Map<string, number>()

export function recordNotionEvent(event: NotionServerEvent) {
  const key = `${event.operation}.${event.outcome}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

export const getNotionRequestCounts = () => Object.fromEntries(counts)
```

Pass `recordNotionEvent` as the handler's `onEvent`. The callback is the
package-to-observability Adapter; storage, aggregation, alerting, request IDs,
and dashboards remain owned by the host application.

Alert on sustained authorization failures, schema mismatch, outbox age,
idempotency conflicts, storage quarantine, and Notion error/retry rates. A
healthy HTTP endpoint alone does not prove that browser outboxes are draining.
