import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  NotionPageContentClient,
  NotionSyncState,
} from '../src/index.js'
import {
  useNotionPageContent,
  useNotionSyncState,
} from '../src/react.js'

describe('React bindings', () => {
  it('provides stable server snapshots for sync and page content', () => {
    const syncState: NotionSyncState = {
      status: 'synced',
      pendingMutations: 2,
      lastSyncedAt: 123,
      remoteVersion: 1,
      isOnline: true,
      storage: 'indexeddb',
      error: null,
      quarantine: null,
    }
    const collection = {
      utils: {
        getSyncState: () => syncState,
        subscribeSyncState: () => () => undefined,
      },
    }
    const content = {
      get: () => undefined,
      subscribe: () => () => undefined,
    } as unknown as NotionPageContentClient

    function Status(): ReturnType<typeof createElement> {
      const sync = useNotionSyncState(collection)
      const page = useNotionPageContent(content, 'note-1')
      return createElement('span', null, `${sync.status}:${page?.status ?? 'empty'}`)
    }

    expect(renderToString(createElement(Status))).toContain('idle:empty')
  })
})
