import { serve } from '@hono/node-server'
import { config as loadEnv } from 'dotenv'
import { Hono } from 'hono'
import {
  createNotionSyncHandler,
  resolveNotionDataSourceId,
} from 'tanstack-db-notion-adapter/server'
import { todoSchema } from './src/todo-schema.generated'

loadEnv({ path: new URL('.env', import.meta.url), quiet: true })

const app = new Hono()
const token = process.env.NOTION_PAT ?? process.env.NOTION_TOKEN
const configuredId =
  process.env.NOTION_DATA_SOURCE_ID ?? process.env.NOTION_DATABASE_ID
let configurationError: string | null = null

if (token && configuredId) {
  try {
    const dataSourceId = await resolveNotionDataSourceId({
      token,
      id: configuredId,
    })
    const sync = createNotionSyncHandler({
      token,
      dataSourceId,
      schema: todoSchema,
      // This example binds to localhost and has no user accounts. Real apps
      // should provide `authorize` and protect each user's data-source access.
      dangerouslyAllowUnauthenticated: true,
      dangerouslyAllowEphemeralIdempotency: true,
    })
    app.all('/api/todos', (context) => sync(context.req.raw))
  } catch (error) {
    configurationError =
      error instanceof Error ? error.message : 'Notion configuration failed.'
  }
} else {
  configurationError =
    'Set NOTION_PAT and either NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID in examples/todos/.env, then restart the API server.'
}

if (configurationError) {
  app.all('/api/todos', (context) =>
    context.json(
      {
        error: {
          code: 'not_configured',
          message: configurationError!,
          retryable: false,
        },
      },
      503,
    ),
  )
}

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`Notion sync API listening on http://localhost:${port}`)
})
