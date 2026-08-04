import { notion, notionSchema } from '../src/index.js'
import type { InferNotionOutput, NotionPageLike } from '../src/index.js'

export const testSchema = notionSchema({
  id: notion.id('Client ID'),
  title: notion.title('Task'),
  completed: notion.checkbox('Done'),
  priority: notion.select('Priority', ['Low', 'High'] as const, 'Low'),
  dueDate: notion.date('Due'),
  createdAt: notion.createdTime('Created'),
  updatedAt: notion.lastEditedTime('Updated'),
  notionPageId: notion.pageId(),
  notionUrl: notion.pageUrl(),
})

export type TestTodo = InferNotionOutput<typeof testSchema.fields>

export function testTodo(overrides: Partial<TestTodo> = {}): TestTodo {
  return {
    id: 'todo-1',
    title: 'Ship the adapter',
    completed: false,
    priority: 'High',
    dueDate: null,
    createdAt: '2026-08-03T12:00:00.000Z',
    updatedAt: '2026-08-03T12:00:00.000Z',
    notionPageId: null,
    notionUrl: null,
    ...overrides,
  }
}

export function notionPage(
  row: TestTodo,
  pageId = row.notionPageId ?? 'page-1',
): NotionPageLike {
  return {
    id: pageId,
    created_time: row.createdAt,
    last_edited_time: row.updatedAt,
    url: row.notionUrl ?? `https://notion.so/${pageId}`,
    in_trash: false,
    properties: {
      'Client ID': {
        type: 'rich_text',
        rich_text: [{ plain_text: row.id }],
      },
      Task: { type: 'title', title: [{ plain_text: row.title }] },
      Done: { type: 'checkbox', checkbox: row.completed },
      Priority: {
        type: 'select',
        select: row.priority ? { name: row.priority } : null,
      },
      Due: {
        type: 'date',
        date: row.dueDate ? { start: row.dueDate } : null,
      },
      Created: { type: 'created_time', created_time: row.createdAt },
      Updated: { type: 'last_edited_time', last_edited_time: row.updatedAt },
    },
  }
}

export const notionProperties = {
  'Client ID': { type: 'rich_text' },
  Task: { type: 'title' },
  Done: { type: 'checkbox' },
  Priority: { type: 'select' },
  Due: { type: 'date' },
  Created: { type: 'created_time' },
  Updated: { type: 'last_edited_time' },
}
