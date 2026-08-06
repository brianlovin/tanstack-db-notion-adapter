# Production operations

## Rate limiting

Pass one shared `NotionRateLimiter` to every handler using the same Notion
connection and `rateLimitScope`. `createMemoryNotionRateLimiter()` coordinates
one JavaScript process. Serverless and multi-process deployments need a shared
scheduler backed by infrastructure such as Redis, a durable actor, or a queue.
The handler also honors retryable responses, `Retry-After`, capped backoff, and
per-request timeouts.

## Idempotency

Writable production handlers require a durable shared `NotionIdempotencyStore`.
See [the store contract](./idempotency-store.md). The package provides a SQLite WAL
implementation for one durable host with multiple processes; horizontally
scaled deployments should use a shared database or serialized service.

## Webhook invalidation

Configure the same `NotionInvalidationStore` and scope on the sync and webhook
handlers. The webhook handler validates its one-time verification token when
configured and deduplicates event IDs through the store. Browser collections
poll only the cheap invalidation version via `invalidationPollIntervalMs`, then
refresh data when it changes. Keep a slower full poll as recovery because
webhook delivery is not a durability boundary.

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

Alert on sustained authorization failures, schema mismatch, outbox age,
idempotency conflicts, storage quarantine, and Notion error/retry rates. A
healthy HTTP endpoint alone does not prove that browser outboxes are draining.
