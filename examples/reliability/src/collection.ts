import { BTreeIndex, createCollection } from '@tanstack/react-db'
import {
  createBrowserNotionStorage,
  notionCollectionOptions,
} from 'tanstack-db-notion-adapter'
import { reliabilitySchema } from './reliability-schema'

let labOnline = true

export function setLabOnline(value: boolean) {
  labOnline = value
}

export function isLabOnline() {
  return labOnline
}

const reliabilityStorage = createBrowserNotionStorage({
  databaseName: 'tanstack-db-notion-reliability-lab',
})

export const incidentCollection = createCollection(
  notionCollectionOptions({
    id: 'notion-reliability-incidents',
    endpoint: '/api/incidents',
    schema: reliabilitySchema,
    storage: reliabilityStorage,
    autoIndex: 'eager',
    defaultIndexType: BTreeIndex,
    pollIntervalMs: 0,
    coordinationStrategy: 'storage-lease',
    isOnline: isLabOnline,
  }),
)
