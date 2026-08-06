import { createNotionPageContentClient } from 'tanstack-db-notion-adapter'
import { noteCollection } from './collection'

export const noteContent = createNotionPageContentClient({
  id: 'notion-notes',
  endpoint: '/api/notes',
  collection: noteCollection,
  debounceMs: 750,
})
