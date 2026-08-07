export const LATEST_NOTION_VERSION = '2026-03-11'

export interface ResolveNotionDataSourceIdConfig {
  token: string
  /** A data source ID, database ID, or pasted Notion database URL. */
  id: string
  notionVersion?: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

interface NotionApiErrorResponse {
  message?: string
}

function notionObjectId(value: string): string {
  const input = value.trim()
  if (!/^https?:\/\//i.test(input)) return input

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('The configured Notion URL is invalid.')
  }
  if (!/(^|\.)notion\.(com|so|site)$/i.test(url.hostname)) {
    throw new Error(
      'Expected a Notion database URL (notion.com, notion.so, or notion.site) or a bare database/data-source ID.',
    )
  }
  const matches = url.pathname.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/gi,
  )
  const id = matches?.at(-1)
  if (!id) throw new Error('Could not find a database ID in the Notion URL.')
  return id
}

/** Resolves a data source ID, single-source database ID, or pasted Notion URL. */
export async function resolveNotionDataSourceId(
  config: ResolveNotionDataSourceIdConfig,
): Promise<string> {
  const fetcher = config.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetcher) throw new Error('A fetch implementation is required.')

  const baseUrl = (config.baseUrl ?? 'https://api.notion.com').replace(/\/$/, '')
  const headers = {
    Authorization: `Bearer ${config.token}`,
    'Notion-Version': config.notionVersion ?? LATEST_NOTION_VERSION,
    Accept: 'application/json',
  }
  const id = notionObjectId(config.id)
  const encodedId = encodeURIComponent(id)
  const dataSourceResponse = await fetcher(
    `${baseUrl}/v1/data_sources/${encodedId}`,
    { headers },
  )
  if (dataSourceResponse.ok) return id

  const dataSourceError = (await dataSourceResponse.json().catch(() => ({}))) as
    NotionApiErrorResponse
  if (dataSourceResponse.status !== 404) {
    throw new Error(
      dataSourceError.message ??
        `Notion could not retrieve the configured data source (HTTP ${dataSourceResponse.status}).`,
    )
  }

  const databaseResponse = await fetcher(`${baseUrl}/v1/databases/${encodedId}`, {
    headers,
  })
  const database = (await databaseResponse.json().catch(() => ({}))) as {
    data_sources?: Array<{ id?: unknown; name?: unknown }>
    message?: string
  }
  if (!databaseResponse.ok) {
    throw new Error(
      database.message ??
        'The configured ID is neither an accessible data source nor database.',
    )
  }

  const dataSources = (database.data_sources ?? []).filter(
    (source): source is { id: string; name?: unknown } =>
      typeof source.id === 'string',
  )
  if (dataSources.length === 0) {
    throw new Error('The configured Notion database has no accessible data sources.')
  }
  if (dataSources.length > 1) {
    const choices = dataSources
      .map((source) => {
        const name =
          typeof source.name === 'string' && source.name.trim()
            ? source.name.trim()
            : 'Unnamed data source'
        return `${name} (${source.id})`
      })
      .join(', ')
    throw new Error(
      `The configured Notion database has multiple data sources: ${choices}. Set NOTION_DATA_SOURCE_ID or pass --id with the exact source you want to sync.`,
    )
  }
  return dataSources[0]!.id
}
