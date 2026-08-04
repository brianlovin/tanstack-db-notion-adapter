import { BTreeIndex, createCollection } from '@tanstack/react-db'
import { notionCollectionOptions } from 'tanstack-db-notion-adapter'
import { todoSchema } from './todo-schema'

export const todoCollection = createCollection(
  notionCollectionOptions({
    id: 'notion-todos',
    endpoint: '/api/todos',
    schema: todoSchema,
    autoIndex: 'eager',
    defaultIndexType: BTreeIndex,
    pollIntervalMs: 60_000,
  }),
)
