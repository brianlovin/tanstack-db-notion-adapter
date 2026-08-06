import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  notion,
  notionSchema,
  NotionSchemaError,
  type InferNotionInput,
} from '../src/index.js'
import { notionPage, testSchema, testTodo } from './fixtures.js'

describe('notionSchema', () => {
  it('retains a generated data source ID for server configuration', () => {
    const schema = notionSchema(
      {
        id: notion.id('Client ID'),
        title: notion.title('Name'),
      },
      { dataSourceId: 'source-1' },
    )

    expect(schema.dataSourceId).toBe('source-1')
  })

  it('omits read-only fields from inferred insert input types', () => {
    const schema = notionSchema({
      id: notion.id('Client ID'),
      title: notion.title('Name'),
      createdAt: notion.createdTime(),
      notionPageId: notion.pageId(),
    })
    type Input = InferNotionInput<typeof schema.fields>

    expectTypeOf<Input>().toHaveProperty('title').toBeString()
    expectTypeOf<Input>().toHaveProperty('id')
    expectTypeOf<Input>().not.toHaveProperty('createdAt')
    expectTypeOf<Input>().not.toHaveProperty('notionPageId')
  })

  it('applies input defaults and keeps select values narrow', async () => {
    const result = await testSchema['~standard'].validate({
      id: 'typed-id',
      title: 'Write tests',
    })

    expect(result).toHaveProperty('value')
    if (!('value' in result)) throw new Error('Expected valid schema output')
    expect(result.value).toMatchObject({
      id: 'typed-id',
      title: 'Write tests',
      completed: false,
      priority: 'Low',
      dueDate: null,
      notionPageId: null,
      notionUrl: null,
    })
    expect(result.value.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('parses Notion properties and serializes only writable fields', () => {
    const row = testTodo({
      notionPageId: 'page-42',
      notionUrl: 'https://notion.so/page-42',
    })

    expect(testSchema.parsePage(notionPage(row, 'page-42'))).toEqual(row)
    expect(testSchema.serialize(row)).toEqual({
      'Client ID': {
        rich_text: [{ type: 'text', text: { content: 'todo-1', link: null } }],
      },
      Task: {
        title: [
          {
            type: 'text',
            text: { content: 'Ship the adapter', link: null },
          },
        ],
      },
      Done: { checkbox: false },
      Priority: { select: { name: 'High' } },
      Due: { date: null },
    })
  })

  it('uses stable property IDs when Notion display names change', () => {
    const schema = notionSchema({
      id: notion.id({ name: 'Client ID', id: 'client-id' }),
      title: notion.title({ name: 'Task', id: 'title' }),
      notionPageId: notion.pageId(),
    })
    const row = schema.parsePage({
      id: 'page-1',
      created_time: '2026-08-03T12:00:00.000Z',
      last_edited_time: '2026-08-03T12:00:00.000Z',
      url: 'https://notion.so/page-1',
      properties: {
        'Renamed client key': {
          id: 'client-id',
          type: 'rich_text',
          rich_text: [{ plain_text: 'todo-1' }],
        },
        'Renamed task': {
          id: 'title',
          type: 'title',
          title: [{ plain_text: 'Stable mapping' }],
        },
      },
    })

    expect(row).toMatchObject({ id: 'todo-1', title: 'Stable mapping' })
    expect(schema.serialize(row)).toEqual({
      'client-id': {
        rich_text: [
          { type: 'text', text: { content: 'todo-1', link: null } },
        ],
      },
      title: {
        title: [
          { type: 'text', text: { content: 'Stable mapping', link: null } },
        ],
      },
    })
  })

  it('preserves rich text, date ranges, people, relations, files, and computed values', () => {
    const schema = notionSchema({
      id: notion.id({ name: 'Client ID', id: 'client' }),
      title: notion.titleItems({ name: 'Name', id: 'title' }),
      summary: notion.richTextItems({ name: 'Summary', id: 'summary' }),
      window: notion.dateRange({ name: 'Window', id: 'window' }),
      owners: notion.people({ name: 'Owners', id: 'owners' }),
      projects: notion.relation({ name: 'Projects', id: 'projects' }),
      attachments: notion.files({ name: 'Files', id: 'files' }),
      score: notion.formula({ name: 'Score', id: 'score' }),
      total: notion.rollup({ name: 'Total', id: 'total' }),
      createdBy: notion.createdBy({ name: 'Created by', id: 'created-by' }),
      sequence: notion.uniqueId({ name: 'ID', id: 'unique-id' }),
      notionPageId: notion.pageId(),
    })
    const annotations = {
      bold: true,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'blue',
    }
    const page = {
      id: 'page-rich',
      created_time: '2026-08-04T12:00:00.000Z',
      last_edited_time: '2026-08-04T12:00:00.000Z',
      url: 'https://notion.so/page-rich',
      properties: {
        'Client ID': {
          id: 'client',
          type: 'rich_text',
          rich_text: [{ plain_text: 'rich-row' }],
        },
        Name: {
          id: 'title',
          type: 'title',
          title: [{
            type: 'text',
            text: { content: 'Launch', link: null },
            annotations,
            plain_text: 'Launch',
            href: null,
          }],
        },
        Summary: {
          id: 'summary',
          type: 'rich_text',
          rich_text: [{
            type: 'mention',
            mention: { type: 'page', page: { id: 'mentioned-page' } },
            annotations: { ...annotations, bold: false },
            plain_text: 'Project brief',
            href: 'https://notion.so/mentioned-page',
          }],
        },
        Window: {
          id: 'window',
          type: 'date',
          date: {
            start: '2026-08-04T09:00:00',
            end: '2026-08-04T10:00:00',
            time_zone: 'America/Los_Angeles',
          },
        },
        Owners: {
          id: 'owners',
          type: 'people',
          people: [{
            id: 'user-1',
            type: 'person',
            name: 'Ada',
            avatar_url: 'https://images.test/ada.png',
            person: { email: 'ada@example.com' },
          }],
        },
        Projects: {
          id: 'projects',
          type: 'relation',
          relation: [{ id: 'project-1' }],
        },
        Files: {
          id: 'files',
          type: 'files',
          files: [
            {
              name: 'brief.pdf',
              type: 'file',
              file: {
                url: 'https://files.test/brief.pdf',
                expiry_time: '2026-08-04T13:00:00.000Z',
              },
            },
            {
              name: 'source.pdf',
              type: 'external',
              external: { url: 'https://example.com/source.pdf' },
            },
          ],
        },
        Score: {
          id: 'score',
          type: 'formula',
          formula: { type: 'number', number: 42 },
        },
        Total: {
          id: 'total',
          type: 'rollup',
          rollup: { type: 'number', number: 7, function: 'sum' },
        },
        'Created by': {
          id: 'created-by',
          type: 'created_by',
          created_by: { id: 'user-1', type: 'person', name: 'Ada' },
        },
        ID: {
          id: 'unique-id',
          type: 'unique_id',
          unique_id: { prefix: 'TASK', number: 12 },
        },
      },
    }

    const row = schema.parsePage(page)
    expect(row).toMatchObject({
      id: 'rich-row',
      title: [{ type: 'text', plainText: 'Launch', annotations }],
      summary: [{
        type: 'mention',
        plainText: 'Project brief',
        mention: { type: 'page', page: { id: 'mentioned-page' } },
      }],
      window: {
        start: '2026-08-04T09:00:00',
        end: '2026-08-04T10:00:00',
        timeZone: 'America/Los_Angeles',
      },
      owners: [{ id: 'user-1', name: 'Ada', email: 'ada@example.com' }],
      projects: [{ id: 'project-1' }],
      attachments: [
        {
          type: 'file',
          url: 'https://files.test/brief.pdf',
          expiryTime: '2026-08-04T13:00:00.000Z',
        },
        { type: 'external', url: 'https://example.com/source.pdf' },
      ],
      score: { type: 'number', value: 42 },
      total: { type: 'number', value: 7, function: 'sum' },
      createdBy: { id: 'user-1', name: 'Ada' },
      sequence: { prefix: 'TASK', number: 12 },
    })
    expect(
      schema.serialize(
        row,
        new Set(['title', 'summary', 'window', 'owners', 'projects']),
      ),
    ).toEqual({
      title: {
        title: [{ type: 'text', text: { content: 'Launch', link: null }, annotations }],
      },
      summary: {
        rich_text: [{
          type: 'mention',
          mention: { type: 'page', page: { id: 'mentioned-page' } },
          annotations: { ...annotations, bold: false },
        }],
      },
      window: {
        date: {
          start: '2026-08-04T09:00:00',
          end: '2026-08-04T10:00:00',
          time_zone: 'America/Los_Angeles',
        },
      },
      owners: { people: [{ id: 'user-1' }] },
      projects: { relation: [{ id: 'project-1' }] },
    })
  })

  it('rejects invalid property values with field paths', async () => {
    const result = await testSchema['~standard'].validate({
      title: 'Invalid priority',
      priority: 'Urgent',
    })

    expect(result).toHaveProperty('issues')
    if (!('issues' in result)) throw new Error('Expected schema issues')
    expect(result.issues?.[0]?.path).toEqual(['priority'])
  })

  it('requires one stable or page id and one title field', () => {
    expect(() =>
      notionSchema({ title: notion.title('Task') }),
    ).toThrow(NotionSchemaError)
    expect(() =>
      notionSchema({
        id: notion.id('Client ID'),
        title: notion.title('Task'),
        otherTitle: notion.title('Other'),
      }),
    ).toThrow(NotionSchemaError)
  })

  it('uses the Notion page ID as the key for read-only schemas', () => {
    const schema = notionSchema({
      id: notion.pageId(),
      title: notion.title('Name'),
    })
    const row = schema.parsePage({
      id: 'page-1',
      created_time: '2026-08-03T12:00:00.000Z',
      last_edited_time: '2026-08-03T12:00:00.000Z',
      url: 'https://notion.so/page-1',
      properties: {
        Name: {
          id: 'title',
          type: 'title',
          title: [{ plain_text: 'Listening history' }],
        },
      },
    })

    expect(row.id).toBe('page-1')
    expect(schema.getKey(row)).toBe('page-1')
  })
})
