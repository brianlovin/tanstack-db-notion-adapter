import { createNotionPageContentClient } from 'tanstack-db-notion-adapter'

export const noteContent = createNotionPageContentClient({
  id: 'notion-notes',
  endpoint: '/api/notes',
  debounceMs: 750,
})
