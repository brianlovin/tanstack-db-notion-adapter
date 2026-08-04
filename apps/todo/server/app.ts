import { resolve } from "node:path";
import { Hono } from "hono";
import {
  createMemoryNotionInvalidationStore,
  createMemoryNotionRateLimiter,
  createNotionSyncHandler,
  createNotionWebhookHandler,
  resolveNotionDataSourceId,
  type NotionServerEvent,
} from "tanstack-db-notion-adapter/server";
import { todoSchema } from "../src/todo-schema.generated";
import { createTodoAuth } from "./auth";
import type { TodoEnvironment } from "./environment";
import { createSqliteIdempotencyStore } from "./idempotency";

interface RequestMetrics {
  successful: number;
  retried: number;
  failed: number;
  lastEvent: NotionServerEvent | null;
}

export async function createTodoApi(environment: TodoEnvironment): Promise<Hono> {
  if (!environment.token || !environment.dataSourceId) {
    throw new Error("Set NOTION_PAT and NOTION_DATA_SOURCE_ID before starting Daylight.");
  }

  const auth = createTodoAuth(environment);
  const dataSourceId = await resolveNotionDataSourceId({
    token: environment.token,
    id: environment.dataSourceId,
  });
  const rateLimiter = createMemoryNotionRateLimiter();
  const invalidationStore = createMemoryNotionInvalidationStore();
  const scope = `daylight:${dataSourceId}`;
  const idempotencyStore = createSqliteIdempotencyStore(
    resolve(environment.dataDirectory, "idempotency.sqlite"),
  );
  const metrics: RequestMetrics = {
    successful: 0,
    retried: 0,
    failed: 0,
    lastEvent: null,
  };
  const onEvent = (event: NotionServerEvent) => {
    metrics.lastEvent = event;
    if (event.outcome === "success") metrics.successful += 1;
    else if (event.outcome === "retry") metrics.retried += 1;
    else metrics.failed += 1;
  };

  const sync = createNotionSyncHandler({
    token: environment.token,
    dataSourceId,
    schema: todoSchema,
    authorize: auth.authorize,
    idempotencyStore,
    pageContent: true,
    validateSchema: true,
    rateLimiter,
    rateLimitScope: scope,
    invalidationStore,
    invalidationScope: scope,
    onEvent,
  });
  const webhook = environment.webhookVerificationToken
    ? createNotionWebhookHandler({
        dataSourceId,
        invalidationStore,
        invalidationScope: scope,
        verificationToken: environment.webhookVerificationToken,
      })
    : null;

  const app = new Hono();
  app.get("/api/session", (context) => auth.session(context));
  app.post("/api/session", async (context) => {
    const origin = context.req.header("origin");
    if (origin && origin !== environment.webOrigin) {
      return context.json({ error: "Origin not allowed." }, 403);
    }
    return await auth.login(context);
  });
  app.delete("/api/session", (context) => auth.logout(context));
  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      authenticated: !auth.bypassed,
      webhookConfigured: webhook !== null,
      notion: metrics,
    }),
  );
  app.all("/api/todos", (context) => sync(context.req.raw));
  app.post("/api/notion/webhook", async (context) => {
    if (!webhook) {
      return context.json({ error: "Notion webhooks are not configured." }, 503);
    }
    return await webhook(context.req.raw);
  });

  return app;
}
