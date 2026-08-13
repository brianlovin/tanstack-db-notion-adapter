# Page-content sync

Notion data-source properties and page bodies use separate APIs. Collection
rows stay eager; page bodies are loaded only when the UI needs them.

## Setup

Enable content routes on the server:

```ts
// server/api/notes.ts — server
const sync = createNotionSyncHandler({
  // token, generated schema, authorization, and idempotency...
  pageContent: true,
})
```

Connect the content client to the row collection:

```ts
// data/notes.ts — client
export const noteContent = createNotionPageContentClient({
  id: 'notes',
  endpoint: '/api/notes',
  collection: notes,
})
```

Passing `collection` is important. When an offline insert later receives its
Notion page ID, the content client attaches and flushes the draft even if that
note is not selected.

## Create and edit

Create the durable body before inserting its row:

```ts
// actions.ts — client
const id = crypto.randomUUID()
await noteContent.createDraft(id, '# New note')
notes.insert({ id, title: 'New note' })
```

Open an existing page with `attachPage`, then update it locally:

```ts
// Editor.tsx — client
await noteContent.attachPage(note.id, note.notionPageId)
await noteContent.update(note.id, nextMarkdown)
```

`update` persists immediately and debounces only the remote write. Use
`flush(id)` for save-now or retry behavior. `load` is the lower-level remote
read; most editors should use `attachPage`.

If the user cancels a new row or explicitly abandons locally cached content,
delete that one durable content record with an explicit data-loss acknowledgement:

```ts
await noteContent.discardDraft(id, { acceptDataLoss: true })
```

This removes only the local draft/cache. It does not edit or delete an attached
Notion page. The operation is idempotent, so cancellation cleanup may call it
even when draft creation did not finish.

## Direct edits in Notion

`useNotionPageContent` watches the currently rendered page. Watched pages are
revalidated when the window regains focus and every 60 seconds by default:

```ts
// data/notes.ts — client
export const noteContent = createNotionPageContentClient({
  id: 'notes',
  endpoint: '/api/notes',
  collection: notes,
  pollIntervalMs: 60_000,
  refreshOnWindowFocus: true,
})
```

This deliberately avoids fetching every body in the data source. Set
`pollIntervalMs: 0` to disable periodic revalidation. Non-React applications
can use `watch(key)` and `refresh(key)` directly.

For lower-latency production sync, subscribe to Notion's
[`page.content_updated`](https://developers.notion.com/reference/webhooks/page-content-updated)
webhook and configure the adapter's invalidation store. The event is a change
signal rather than the changed content, so the browser still retrieves the
latest watched page after observing a version change:

```ts
// data/notes.ts — client
export const noteContent = createNotionPageContentClient({
  id: 'notes',
  endpoint: '/api/notes',
  collection: notes,
  invalidationPollIntervalMs: 15_000,
})
```

Notion aggregates these events and says delivery can take several minutes, so
focus and periodic revalidation remain useful fallbacks.

Notion normalizes Markdown through its block model. Equivalent content can
return with different whitespace, such as blank lines removed between blocks.

## Conflicts and offline behavior

Pending bodies survive reloads and reconnect automatically. If both Notion and
the local draft changed, the client retains both versions and reports
`status: 'conflict'`. Resolve explicitly with `acceptRemote(key)` or
`overwriteRemote(key, { acceptDataLoss: true })`.

For authenticated apps, set `autoStart: false`, then call `resumeSync()` after
session restoration and `pauseSync()` before logout. Cached content remains
available while remote requests are paused.
