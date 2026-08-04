import { BTreeIndex, createCollection } from '@tanstack/react-db'
import { notionCollectionOptions } from 'tanstack-db-notion-adapter'
import { noteSchema } from './note-schema'

export const noteCollection = createCollection(
  notionCollectionOptions({
    id: 'notion-notes',
    endpoint: '/api/notes',
    schema: noteSchema,
    autoIndex: 'eager',
    defaultIndexType: BTreeIndex,
    pollIntervalMs: 60_000,
  }),
)
