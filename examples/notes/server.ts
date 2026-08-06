import { serve } from '@hono/node-server'
import { config as loadEnv } from 'dotenv'
import { Hono } from 'hono'
import { createNotionSyncHandler } from 'tanstack-db-notion-adapter/server'
import { noteSchema } from './src/notion.generated'

loadEnv({ path: new URL('.env.local', import.meta.url), quiet: true })
loadEnv({ path: new URL('.env', import.meta.url), quiet: true })

const app = new Hono()
const token = process.env.NOTION_PAT ?? process.env.NOTION_TOKEN
let configurationError: string | null = null

if (token) {
  try {
    const sync = createNotionSyncHandler({
      token,
      schema: noteSchema,
      pageContent: true,
      // This local example has no accounts. Production apps must authorize
      // each request and scope users to data sources they may access.
      dangerouslyAllowUnauthenticated: true,
      dangerouslyAllowEphemeralIdempotency: true,
    })
    app.all('/api/notes', (context) => sync(context.req.raw))
  } catch (error) {
    configurationError =
      error instanceof Error ? error.message : 'Notion configuration failed.'
  }
} else {
  configurationError =
    'Run `npx tanstack-db-notion init` in examples/notes, then restart the Notes API server.'
}

if (configurationError) {
  app.all('/api/notes', (context) =>
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

const port = Number(process.env.PORT ?? 8788)
serve({ fetch: app.fetch, port }, () => {
  console.log(`Notes sync API listening on http://localhost:${port}`)
})
