import { describe, expect, it, vi } from 'vitest'
import {
  assertNotionSchemaManifest,
  createNotionSchemaManifest,
  diffNotionSchema,
  formatNotionSchemaDrift,
  generateNotionSchemaSource,
  inspectNotionDataSource,
  NOTION_SCHEMA_MANIFEST_URL,
  pushNotionSchema,
  validateNotionSchemaManifest,
  type NotionDataSourceSnapshot,
  type NotionSchemaManifest,
} from '../src/schema-tools.js'

const blankSnapshot: NotionDataSourceSnapshot = {
  notionVersion: '2026-03-11',
  dataSourceId: 'source-1',
  name: 'Tasks',
  properties: [
    {
      id: 'title',
      name: 'Name',
      type: 'title',
      config: {},
    },
  ],
}

function todoManifest(): NotionSchemaManifest {
  return {
    version: 1,
    notionVersion: '2026-03-11',
    dataSourceId: 'source-1',
    exportName: 'todoSchema',
    syncKey: { key: 'id', name: 'Client ID' },
    metadata: {
      pageId: 'notionPageId',
      pageUrl: 'notionUrl',
      createdTime: 'createdAt',
      lastEditedTime: 'updatedAt',
    },
    properties: [
      { key: 'title', name: 'Name', type: 'title', config: {} },
      {
        key: 'completed',
        name: 'Done',
        type: 'checkbox',
        defaultValue: false,
        config: {},
      },
      {
        key: 'priority',
        name: 'Priority',
        type: 'select',
        options: [{ name: 'Low' }, { name: 'High' }],
      },
    ],
  }
}

describe('Notion schema tooling', () => {
  it('rejects invalid identifiers and generated field collisions before generation', () => {
    const manifest = todoManifest()
    manifest.exportName = 'default'
    manifest.properties[0]!.key = 'not-valid'
    manifest.metadata.pageId = 'completed'

    const issues = validateNotionSchemaManifest(manifest)

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'exportName' }),
        expect.objectContaining({ path: 'properties[0].key' }),
        expect.objectContaining({ path: 'properties[1].key' }),
      ]),
    )
    expect(() => assertNotionSchemaManifest(manifest)).toThrow(
      'Invalid Notion schema manifest',
    )
    expect(() => generateNotionSchemaSource(manifest)).toThrow(
      'properties[0].key',
    )
  })

  it('preserves developer field ordering when Notion returns another order', () => {
    const existing: NotionSchemaManifest = {
      ...todoManifest(),
      syncKey: { key: 'id', name: 'Client ID', propertyId: 'client-id' },
      properties: [
        {
          key: 'priority',
          name: 'Priority',
          propertyId: 'priority-id',
          type: 'select',
          options: [{ name: 'Low' }, { name: 'High' }],
        },
        {
          key: 'completed',
          name: 'Done',
          propertyId: 'done-id',
          type: 'checkbox',
          defaultValue: false,
          config: {},
        },
        {
          key: 'title',
          name: 'Name',
          propertyId: 'title',
          type: 'title',
          config: {},
        },
      ],
    }
    const remote: NotionDataSourceSnapshot = {
      ...blankSnapshot,
      properties: [
        { id: 'done-id', name: 'Done', type: 'checkbox', config: {} },
        { id: 'title', name: 'Name', type: 'title', config: {} },
        { id: 'when-id', name: 'When', type: 'date', config: {} },
        {
          id: 'priority-id',
          name: 'Priority',
          type: 'select',
          config: { options: [] },
          options: [],
        },
        {
          id: 'client-id',
          name: 'Client ID',
          type: 'rich_text',
          config: {},
        },
      ],
    }

    const next = createNotionSchemaManifest(remote, { existing })

    expect(next.properties.map((field) => field.name)).toEqual([
      'Priority',
      'Done',
      'Name',
      'When',
    ])
  })

  it('adds the manifest schema hint and stores select options only once', () => {
    const snapshot: NotionDataSourceSnapshot = {
      ...blankSnapshot,
      properties: [
        ...blankSnapshot.properties,
        {
          id: 'mood-id',
          name: 'Mood',
          type: 'select',
          options: [
            { id: 'happy-id', name: 'Happy', color: 'yellow' },
            { id: 'calm-id', name: 'Calm', color: 'blue' },
          ],
          config: {
            options: [
              { id: 'happy-id', name: 'Happy', color: 'yellow' },
              { id: 'calm-id', name: 'Calm', color: 'blue' },
            ],
          },
        },
      ],
    }

    const manifest = createNotionSchemaManifest(snapshot)

    expect(manifest.$schema).toBe(NOTION_SCHEMA_MANIFEST_URL)
    expect(manifest.properties.find((field) => field.key === 'mood')).toMatchObject({
      options: [
        { id: 'happy-id', name: 'Happy', color: 'yellow' },
        { id: 'calm-id', name: 'Calm', color: 'blue' },
      ],
      config: {},
    })
    expect(
      manifest.properties.find((field) => field.key === 'mood')?.config,
    ).not.toHaveProperty('options')

    const customSchema = createNotionSchemaManifest(snapshot, {
      existing: { ...manifest, $schema: 'https://schemas.test/notion.json' },
    })
    expect(customSchema.$schema).toBe('https://schemas.test/notion.json')
  })

  it('describes schema drift without presenting it as a push plan', () => {
    const manifest = todoManifest()
    manifest.properties[1]!.propertyId = 'done-id'
    const operations = diffNotionSchema(manifest, {
      ...blankSnapshot,
      properties: [
        ...blankSnapshot.properties,
        { id: 'done-id', name: 'Finished', type: 'checkbox', config: {} },
      ],
    })

    expect(formatNotionSchemaDrift(operations)).toContain(
      'property done-id is named "Finished" in Notion; manifest expects "Done"',
    )
    expect(formatNotionSchemaDrift(operations)).toContain(
      '"Client ID" is missing from Notion',
    )
    expect(formatNotionSchemaDrift(operations)).not.toContain('+ rename')
  })

  it('detects Notion-only properties in strict drift checks without planning their removal', () => {
    const remote = {
      ...blankSnapshot,
      properties: [
        ...blankSnapshot.properties,
        { id: 'location-id', name: 'Location', type: 'rich_text' as const, config: {} },
      ],
    }

    expect(diffNotionSchema(todoManifest(), remote)).not.toContainEqual(
      expect.objectContaining({ kind: 'remote_addition' }),
    )

    const strict = diffNotionSchema(todoManifest(), remote, {
      includeRemoteAdditions: true,
    })
    expect(strict).toContainEqual(
      expect.objectContaining({
        kind: 'remote_addition',
        field: expect.objectContaining({
          name: 'Location',
          propertyId: 'location-id',
          type: 'rich_text',
        }),
        destructive: false,
        supported: false,
      }),
    )
    expect(formatNotionSchemaDrift(strict)).toContain(
      '"Location" exists in Notion but is not tracked by the manifest',
    )
  })

  it('introspects complex properties with typed codecs and preserves unknown types', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      if (url.pathname === '/v1/data_sources/source-1') {
        return Response.json({
          object: 'data_source',
          id: 'source-1',
          title: [{ plain_text: 'Projects' }],
          properties: {
            Name: { id: 'title', name: 'Name', type: 'title', title: {} },
            Score: {
              id: 'score-id',
              name: 'Score',
              type: 'formula',
              formula: { expression: '1 + 1' },
            },
            Future: {
              id: 'future-id',
              name: 'Future',
              type: 'mystery_widget',
              mystery_widget: { version: 1 },
            },
          },
        })
      }
      return Response.json({ message: 'Missing' }, { status: 404 })
    })

    const snapshot = await inspectNotionDataSource({
      token: 'pat',
      id: 'source-1',
      fetch: fetch as typeof globalThis.fetch,
      baseUrl: 'https://api.notion.test',
    })
    const manifest = createNotionSchemaManifest(snapshot)
    const source = generateNotionSchemaSource(manifest)

    expect(snapshot.name).toBe('Projects')
    expect(snapshot.properties[1]).toMatchObject({
      id: 'score-id',
      type: 'formula',
    })
    expect(source).toContain(
      'notion.formula({ name: "Score", id: "score-id" })',
    )
    expect(source).toContain('}, { dataSourceId: "source-1" })')
    expect(source).toContain('type NotionDataSourceSchemaInput = InferNotionInput<')
    expect(snapshot.properties[2]).toMatchObject({
      id: 'future-id',
      type: 'mystery_widget',
      config: { version: 1 },
    })
    expect(source).toContain(
      'notion.raw({ name: "Future", id: "future-id" }, "mystery_widget")',
    )
  })

  it('plans additive changes for a code-first schema against a blank table', () => {
    const operations = diffNotionSchema(todoManifest(), blankSnapshot)

    expect(operations.map((operation) => [operation.kind, operation.field.name]))
      .toEqual([
        ['add', 'Client ID'],
        ['add', 'Done'],
        ['add', 'Priority'],
      ])
    expect(operations.every((operation) => !operation.destructive)).toBe(true)
  })

  it('pushes additive changes and returns stable property IDs', async () => {
    let patched = false
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        )
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body))
          expect(body.properties).toEqual({
            'Client ID': { rich_text: {} },
            Done: { checkbox: {} },
            Priority: {
              select: { options: [{ name: 'Low' }, { name: 'High' }] },
            },
          })
          patched = true
          return Response.json({ object: 'data_source' })
        }
        if (url.pathname === '/v1/data_sources/source-1') {
          return Response.json(
            patched
              ? {
                  properties: {
                    Name: {
                      id: 'title',
                      name: 'Name',
                      type: 'title',
                      title: {},
                    },
                    'Client ID': {
                      id: 'client-id',
                      name: 'Client ID',
                      type: 'rich_text',
                      rich_text: {},
                    },
                    Done: {
                      id: 'done-id',
                      name: 'Done',
                      type: 'checkbox',
                      checkbox: {},
                    },
                    Priority: {
                      id: 'priority-id',
                      name: 'Priority',
                      type: 'select',
                      select: {
                        options: [{ id: 'low-id', name: 'Low' }, { id: 'high-id', name: 'High' }],
                      },
                    },
                  },
                }
              : {
                  properties: {
                    Name: {
                      id: 'title',
                      name: 'Name',
                      type: 'title',
                      title: {},
                    },
                  },
                },
          )
        }
        return Response.json({ message: 'Missing' }, { status: 404 })
      },
    )

    const snapshot = await pushNotionSchema({
      token: 'pat',
      id: 'source-1',
      manifest: todoManifest(),
      snapshot: blankSnapshot,
      fetch: fetch as typeof globalThis.fetch,
      baseUrl: 'https://api.notion.test',
    })

    expect(patched).toBe(true)
    expect(snapshot.properties.map((property) => property.id)).toContain(
      'client-id',
    )
  })
})
