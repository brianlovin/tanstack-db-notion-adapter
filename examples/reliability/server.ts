import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import {
  createMemoryNotionIdempotencyStore,
  createNotionSyncHandler,
  type NotionIdempotencyOperation,
  type NotionIdempotencyStore,
} from 'tanstack-db-notion-adapter/server'
import {
  reliabilitySchema,
  type Incident,
} from './src/reliability-schema'
import type { NotionPageLike } from 'tanstack-db-notion-adapter/advanced'

const app = new Hono()
const pages = new Map<string, NotionPageLike>()
let createdPages = 0
let notionCreateCalls = 0
let mutationRequests = 0
let ledgerExecutions = 0
let handlerCursor = 0
let dropNextSuccessfulMutationResponse = false

function text(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      const richText = record.text as Record<string, unknown> | undefined
      return typeof richText?.content === 'string' ? richText.content : ''
    })
    .join('')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function propertyText(
  properties: Record<string, unknown>,
  name: string,
): string {
  const property = asRecord(properties[name])
  return text(property?.title ?? property?.rich_text)
}

function propertySelect(
  properties: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const property = asRecord(properties[name])
  if (!property) return undefined
  const select = asRecord(property.select)
  return typeof select?.name === 'string' ? select.name : null
}

function pageFromIncident(row: Incident, pageId: string): NotionPageLike {
  return {
    id: pageId,
    created_time: row.createdAt,
    last_edited_time: row.updatedAt,
    url: `https://notion.so/${pageId}`,
    in_trash: false,
    properties: {
      'Client ID': {
        id: 'client-id',
        type: 'rich_text',
        rich_text: [{ plain_text: row.id }],
      },
      Incident: {
        id: 'title',
        type: 'title',
        title: [{ plain_text: row.title }],
      },
      Owner: {
        id: 'owner',
        type: 'rich_text',
        rich_text: [{ plain_text: row.owner }],
      },
      Status: {
        id: 'status',
        type: 'select',
        select: row.status ? { name: row.status } : null,
      },
      Severity: {
        id: 'severity',
        type: 'select',
        select: row.severity ? { name: row.severity } : null,
      },
      Created: {
        id: 'created',
        type: 'created_time',
        created_time: row.createdAt,
      },
      Updated: {
        id: 'updated',
        type: 'last_edited_time',
        last_edited_time: row.updatedAt,
      },
    },
  }
}

const notionFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  )
  const method = init?.method ?? 'GET'
  const body = asRecord(
    init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
  )

  if (method === 'GET' && url.pathname === '/v1/data_sources/reliability-source') {
    return Response.json({
      object: 'data_source',
      properties: {
        'Client ID': { id: 'client-id', type: 'rich_text' },
        Incident: { id: 'title', type: 'title' },
        Owner: { id: 'owner', type: 'rich_text' },
        Status: { id: 'status', type: 'select' },
        Severity: { id: 'severity', type: 'select' },
        Created: { id: 'created', type: 'created_time' },
        Updated: { id: 'updated', type: 'last_edited_time' },
      },
    })
  }

  if (method === 'POST' && url.pathname.endsWith('/query')) {
    const filter = asRecord(body?.filter)
    const richText = asRecord(filter?.rich_text)
    const key = typeof richText?.equals === 'string' ? richText.equals : undefined
    const visible = [...pages.values()].filter((page) => page.in_trash !== true)
    const results = key
      ? visible.filter((page) => reliabilitySchema.parsePage(page).id === key)
      : visible
    return Response.json({ results, has_more: false, next_cursor: null })
  }

  if (method === 'POST' && url.pathname === '/v1/pages') {
    notionCreateCalls += 1
    createdPages += 1
    const now = new Date().toISOString()
    const properties = asRecord(body?.properties) ?? {}
    const row: Incident = {
      id: propertyText(properties, 'Client ID'),
      title: propertyText(properties, 'Incident'),
      owner: propertyText(properties, 'Owner'),
      status: propertySelect(properties, 'Status') as Incident['status'],
      severity: propertySelect(properties, 'Severity') as Incident['severity'],
      createdAt: now,
      updatedAt: now,
      notionPageId: `page-${createdPages}`,
      notionUrl: `https://notion.so/page-${createdPages}`,
    }
    const page = pageFromIncident(row, `page-${createdPages}`)
    pages.set(page.id, page)
    return Response.json(page)
  }

  const pageId = url.pathname.match(/^\/v1\/pages\/(.+)$/)?.[1]
  if (pageId && method === 'GET') {
    const page = pages.get(pageId)
    return page
      ? Response.json(page)
      : Response.json({ code: 'object_not_found' }, { status: 404 })
  }

  if (pageId && method === 'PATCH') {
    const page = pages.get(pageId)
    if (!page) return Response.json({ code: 'object_not_found' }, { status: 404 })
    if (body?.in_trash === true) {
      page.in_trash = true
      return Response.json(page)
    }
    const current = reliabilitySchema.parsePage(page)
    const properties = asRecord(body?.properties) ?? {}
    const next: Incident = {
      ...current,
      title: properties.Incident
        ? propertyText(properties, 'Incident')
        : current.title,
      owner: properties.Owner ? propertyText(properties, 'Owner') : current.owner,
      status:
        (propertySelect(properties, 'Status') as Incident['status'] | undefined) ??
        current.status,
      severity:
        (propertySelect(
          properties,
          'Severity',
        ) as Incident['severity'] | undefined) ?? current.severity,
      updatedAt: new Date().toISOString(),
    }
    const updated = pageFromIncident(next, pageId)
    pages.set(pageId, updated)
    return Response.json(updated)
  }

  return Response.json(
    { code: 'unhandled', message: `${method} ${url.pathname}` },
    { status: 500 },
  )
}

let baseLedger = createMemoryNotionIdempotencyStore()
let ledger: NotionIdempotencyStore = instrumentLedger(baseLedger)

function instrumentLedger(store: NotionIdempotencyStore): NotionIdempotencyStore {
  return {
    execute<T>(operation: NotionIdempotencyOperation, run: () => Promise<T>) {
      return store.execute(operation, async () => {
        ledgerExecutions += 1
        return run()
      })
    },
  }
}

function createHandlers() {
  return [0, 1].map(() =>
    createNotionSyncHandler({
      token: 'local-reliability-fixture',
      dataSourceId: 'reliability-source',
      schema: reliabilitySchema,
      fetch: notionFetch as typeof fetch,
      baseUrl: 'https://notion.fixture',
      minimumRequestIntervalMs: 0,
      maxRetries: 0,
      authorize: () => true,
      idempotencyStore: ledger,
    }),
  )
}

let handlers = createHandlers()

app.all('/api/incidents', async (context) => {
  const isMutation = context.req.method === 'POST'
  if (isMutation) mutationRequests += 1
  const handler = handlers[handlerCursor++ % handlers.length]!
  const response = await handler(context.req.raw)
  if (isMutation && response.ok && dropNextSuccessfulMutationResponse) {
    dropNextSuccessfulMutationResponse = false
    return context.json(
      {
        error: {
          code: 'simulated_lost_response',
          message: 'The server committed the write, but the response was lost.',
          retryable: true,
        },
      },
      503,
    )
  }
  return response
})

app.post('/api/lab/arm-lost-response', (context) => {
  dropNextSuccessfulMutationResponse = true
  return context.json({ armed: true })
})

app.post('/api/lab/remote-edit', async (context) => {
  const body = (await context.req.json()) as {
    key: string
    field: 'title' | 'owner' | 'status' | 'severity'
    value: string
  }
  const entry = [...pages.entries()].find(
    ([, page]) => reliabilitySchema.parsePage(page).id === body.key,
  )
  if (!entry) return context.json({ error: 'Row not found.' }, 404)
  const [pageId, page] = entry
  const row = reliabilitySchema.parsePage(page)
  const updated = {
    ...row,
    [body.field]: body.value,
    updatedAt: new Date().toISOString(),
  } as Incident
  pages.set(pageId, pageFromIncident(updated, pageId))
  return context.json({ row: reliabilitySchema.parsePage(pages.get(pageId)!) })
})

app.get('/api/lab/state', (context) =>
  context.json({
    rows: [...pages.values()]
      .filter((page) => page.in_trash !== true)
      .map((page) => reliabilitySchema.parsePage(page)),
    telemetry: {
      mutationRequests,
      ledgerExecutions,
      notionCreateCalls,
      handlerInstances: handlers.length,
      nextResponseWillBeLost: dropNextSuccessfulMutationResponse,
    },
  }),
)

app.post('/api/lab/reset', (context) => {
  pages.clear()
  createdPages = 0
  notionCreateCalls = 0
  mutationRequests = 0
  ledgerExecutions = 0
  handlerCursor = 0
  dropNextSuccessfulMutationResponse = false
  baseLedger = createMemoryNotionIdempotencyStore()
  ledger = instrumentLedger(baseLedger)
  handlers = createHandlers()
  return context.json({ reset: true })
})

serve({ fetch: app.fetch, port: 8789 }, () => {
  console.log('Reliability Lab API listening on http://localhost:8789')
})
