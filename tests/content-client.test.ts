import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryNotionStorage,
  createNotionPageContentClient,
  type NotionPageContent,
  type NotionPageContentSnapshot,
} from '../src/index.js'

function content(markdown: string): NotionPageContent {
  return {
    pageId: 'page-1',
    markdown,
    truncated: false,
    unknownBlockIds: [],
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createNotionPageContentClient', () => {
  it('persists every draft immediately and debounces remote writes', async () => {
    vi.useFakeTimers()
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    const sentMarkdown: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        sentMarkdown.push(body.markdown)
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 750,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'First draft')

    const afterFirstEdit = await storage.load<NotionPageContentSnapshot>(
      'notes:page-content',
    )
    expect(afterFirstEdit?.rows[0]).toMatchObject({
      markdown: 'First draft',
      baseMarkdown: 'Original',
      pending: true,
      status: 'saved-local',
    })
    expect(sentMarkdown).toEqual([])

    await vi.advanceTimersByTimeAsync(749)
    await client.update('note-1', 'Final draft')
    await vi.advanceTimersByTimeAsync(749)
    expect(sentMarkdown).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    await client.flush('note-1')
    expect(sentMarkdown).toEqual(['Final draft'])
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Final draft',
      baseMarkdown: 'Final draft',
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('coalesces edits made while a content write is in flight', async () => {
    const storage = createMemoryNotionStorage()
    let resolveFirstWrite!: (response: Response) => void
    let postCount = 0
    const sentMarkdown: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json(content('Original'))
      const body = JSON.parse(String(init.body)) as { markdown: string }
      sentMarkdown.push(body.markdown)
      postCount += 1
      if (postCount === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirstWrite = resolve
        })
      }
      return Response.json(content(body.markdown))
    })
    const client = createNotionPageContentClient({
      id: 'in-flight-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'First draft')
    const firstFlush = client.flush('note-1')
    await vi.waitFor(() => expect(postCount).toBe(1))

    await client.update('note-1', 'Typed during request')
    resolveFirstWrite(Response.json(content('First draft')))
    await firstFlush
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Typed during request',
      baseMarkdown: 'First draft',
      pending: true,
    })

    await client.flush('note-1')
    expect(sentMarkdown).toEqual(['First draft', 'Typed during request'])
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Typed during request',
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('restores a pending offline draft after recreating the client', async () => {
    const storage = createMemoryNotionStorage()
    let isOnline = true
    let remoteMarkdown = 'Original'
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const first = createNotionPageContentClient({
      id: 'offline-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
      isOnline: () => isOnline,
    })
    await first.load('note-1', 'page-1')
    isOnline = false
    await first.update('note-1', 'Offline journal entry')
    first.cleanup()

    const restored = createNotionPageContentClient({
      id: 'offline-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
      isOnline: () => isOnline,
    })
    await restored.ready()
    expect(restored.get('note-1')).toMatchObject({
      markdown: 'Offline journal entry',
      pending: true,
      status: 'offline',
    })

    isOnline = true
    await restored.flush('note-1')
    expect(restored.get('note-1')).toMatchObject({
      pending: false,
      status: 'synced',
    })
    restored.cleanup()
  })

  it('keeps a new offline row draft under its client key until Notion assigns a page', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = ''
    const sentPageIds: Array<string> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          pageId: string
          markdown: string
        }
        sentPageIds.push(body.pageId)
        remoteMarkdown = body.markdown
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'new-note-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.createDraft('client-note-1')
    await client.update('client-note-1', 'Written before the page exists')
    await client.flush('client-note-1')
    expect(sentPageIds).toEqual([])
    expect(client.get('client-note-1')).toMatchObject({
      notionPageId: null,
      pending: true,
    })

    await client.attachPage('client-note-1', 'page-1')
    await client.flush('client-note-1')
    expect(sentPageIds).toEqual(['page-1'])
    expect(client.get('client-note-1')).toMatchObject({
      key: 'client-note-1',
      notionPageId: 'page-1',
      pending: false,
      markdown: 'Written before the page exists',
    })
    client.cleanup()
  })

  it('keeps both versions when Notion changed and resolves explicitly', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Response.json(
          {
            error: {
              code: 'page_content_conflict',
              message: 'The page changed in Notion after this draft was loaded.',
              retryable: false,
            },
          },
          { status: 409 },
        )
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'conflict-notes',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'Local draft')
    remoteMarkdown = 'Remote edit'
    await client.flush('note-1')

    expect(client.get('note-1')).toMatchObject({
      markdown: 'Local draft',
      remoteMarkdown: 'Remote edit',
      pending: true,
      status: 'conflict',
    })

    await client.acceptRemote('note-1')
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Remote edit',
      remoteMarkdown: null,
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('retries a lost successful response without losing the pending draft', async () => {
    const storage = createMemoryNotionStorage()
    let remoteMarkdown = 'Original'
    let loseResponse = true
    let remoteWrites = 0
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { markdown: string }
        if (remoteMarkdown !== body.markdown) {
          remoteMarkdown = body.markdown
          remoteWrites += 1
        }
        if (loseResponse) {
          loseResponse = false
          throw new TypeError('The successful response disappeared.')
        }
      }
      return Response.json(content(remoteMarkdown))
    })
    const client = createNotionPageContentClient({
      id: 'lost-response-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })

    await client.load('note-1', 'page-1')
    await client.update('note-1', 'Durable draft')
    await expect(client.flush('note-1')).rejects.toThrow(
      'The successful response disappeared.',
    )
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Durable draft',
      pending: true,
      status: 'error',
    })

    await client.flush('note-1')
    expect(remoteWrites).toBe(1)
    expect(client.get('note-1')).toMatchObject({
      markdown: 'Durable draft',
      pending: false,
      status: 'synced',
    })
    client.cleanup()
  })

  it('aborts an in-flight content request and prevents later writes after cleanup', async () => {
    const storage = createMemoryNotionStorage()
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json(content('Original'))
      requestSignal = init.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => reject(requestSignal?.reason),
          { once: true },
        )
      })
    })
    const client = createNotionPageContentClient({
      id: 'cleanup-content',
      endpoint: 'http://app.test/api/notes',
      storage,
      fetch: fetch as typeof globalThis.fetch,
      debounceMs: 60_000,
    })
    await client.load('note-1', 'page-1')
    await client.update('note-1', 'Pending during cleanup')
    const flush = client.flush('note-1')
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    const beforeCleanup = await storage.load<NotionPageContentSnapshot>(
      'cleanup-content:page-content',
    )

    client.cleanup()
    await flush

    expect(requestSignal?.aborted).toBe(true)
    expect(
      await storage.load<NotionPageContentSnapshot>(
        'cleanup-content:page-content',
      ),
    ).toEqual(beforeCleanup)
  })
})
