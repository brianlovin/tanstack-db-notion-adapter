import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import type {
  NotionPageContentSnapshot,
  NotionSyncState,
} from 'tanstack-db-notion-adapter'
import { noteCollection } from './collection'
import { noteContent } from './content'
import { noteKinds, type Note } from './note-schema'

const syncStateFallback: NotionSyncState = {
  status: 'idle',
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: 'memory',
  error: null,
  quarantine: null,
}

function useCollectionSyncState(): NotionSyncState {
  return useSyncExternalStore(
    noteCollection.utils.subscribeSyncState,
    noteCollection.utils.getSyncState,
    () => syncStateFallback,
  )
}

function usePageContent(key: string | null): NotionPageContentSnapshot | undefined {
  return useSyncExternalStore(
    noteContent.subscribe,
    () => (key ? noteContent.get(key) : undefined),
    () => undefined,
  )
}

function formatDay(value: string | null): string {
  if (!value) return 'No date'
  const date = new Date(`${value.slice(0, 10)}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date)
}

function formatEditorDate(value: string | null): string {
  if (!value) return 'Undated note'
  const date = new Date(`${value.slice(0, 10)}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function today(): string {
  const date = new Date()
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function preview(markdown: string | undefined): string {
  if (!markdown) return 'No writing yet'
  const first = markdown
    .split('\n')
    .map((line) => line.replace(/^#{1,4}\s+/, '').trim())
    .find(Boolean)
  return first?.slice(0, 78) ?? 'No writing yet'
}

function contentStatus(
  content: NotionPageContentSnapshot | undefined,
  note: Note | undefined,
): { label: string; tone: string } {
  if (!note) return { label: 'Notebook ready', tone: 'synced' }
  if (!content) {
    if (note.notionPageId) return { label: 'Opening content', tone: 'working' }
    return { label: 'Saved locally', tone: 'local' }
  }
  switch (content.status) {
    case 'syncing':
    case 'loading':
      return { label: 'Sending to Notion', tone: 'working' }
    case 'saved-local':
      if (note.notionPageId) return { label: 'Saved locally', tone: 'local' }
      return { label: 'Waiting for page', tone: 'local' }
    case 'offline':
      return { label: 'Offline · saved locally', tone: 'offline' }
    case 'conflict':
      return { label: 'Two versions', tone: 'error' }
    case 'error':
      return { label: 'Sync needs attention', tone: 'error' }
    case 'synced':
      return { label: 'Synced to Notion', tone: 'synced' }
    default:
      return { label: content.pending ? 'Saved locally' : 'Ready', tone: 'local' }
  }
}

function collectionStatusLabel(status: NotionSyncState['status']): string {
  if (status === 'offline') return 'Working offline'
  if (status === 'error') return 'Page sync stopped'
  return 'Local notebook ready'
}

function collectionStatusDetail(state: NotionSyncState): string {
  if (state.status === 'error') return 'Check the Notes API configuration'
  return `${state.storage} · Notion in the background`
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3.5v13M3.5 10h13" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="m12.8 12.8 3.7 3.7" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m12.5 4.5-5.5 5.5 5.5 5.5" />
    </svg>
  )
}

function SyncLedger({
  content,
  note,
  collection,
}: {
  content: NotionPageContentSnapshot | undefined
  note: Note | undefined
  collection: NotionSyncState
}) {
  const status = contentStatus(content, note)
  const isLocal = content?.pending || !note?.notionPageId

  return (
    <div className="sync-ledger" aria-live="polite">
      <span className={`ledger-light tone-${status.tone}`} />
      <div>
        <strong>{status.label}</strong>
        <small>
          {isLocal
            ? `${noteContent.storage} draft · ${collection.pendingMutations} page change${collection.pendingMutations === 1 ? '' : 's'}`
            : 'Local draft and Notion agree'}
        </small>
      </div>
    </div>
  )
}

export function App() {
  const collectionSync = useCollectionSyncState()
  const { data: queriedNotes = [], isLoading } = useLiveQuery((query) =>
    query
      .from({ note: noteCollection })
      .orderBy(({ note }) => note.updatedAt, 'desc'),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const searchInput = useRef<HTMLInputElement>(null)

  const notes = useMemo(
    () =>
      [...queriedNotes].sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.updatedAt.localeCompare(left.updatedAt),
      ),
    [queriedNotes],
  )
  const visibleNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return notes
    return notes.filter((note) => {
      const cached = noteContent.get(note.id)
      return (
        note.title.toLocaleLowerCase().includes(query) ||
        cached?.markdown.toLocaleLowerCase().includes(query)
      )
    })
  }, [notes, search])
  const selectedNote = notes.find((note) => note.id === selectedId)
  const content = usePageContent(selectedId)

  useEffect(() => {
    if (selectedId && notes.some((note) => note.id === selectedId)) return
    setSelectedId(notes[0]?.id ?? null)
  }, [notes, selectedId])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSidebarOpen(true)
        searchInput.current?.focus()
      } else if (event.key === 'Escape' && document.activeElement === searchInput.current) {
        setSearch('')
        searchInput.current?.blur()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    setTitleDraft(selectedNote?.title ?? '')
  }, [selectedNote?.id, selectedNote?.title])

  useEffect(() => {
    if (!selectedNote) return
    let cancelled = false
    setLoadError(null)
    const open = selectedNote.notionPageId
      ? noteContent.attachPage(selectedNote.id, selectedNote.notionPageId)
      : noteContent.createDraft(selectedNote.id)
    void open.catch((error) => {
      if (!cancelled) {
        setLoadError(error instanceof Error ? error.message : 'Could not open this note.')
      }
    })
    return () => {
      cancelled = true
      void noteContent.flush(selectedNote.id).catch(() => undefined)
    }
  }, [selectedNote?.id, selectedNote?.notionPageId])

  const createNote = async () => {
    const id = crypto.randomUUID()
    await noteContent.createDraft(id)
    noteCollection.insert({
      id,
      title: 'Untitled note',
      kind: 'Note',
      entryDate: today(),
    })
    setSelectedId(id)
    setSidebarOpen(false)
  }

  const selectNote = (id: string) => {
    if (selectedId && selectedId !== id) {
      void noteContent.flush(selectedId).catch(() => undefined)
    }
    setSelectedId(id)
    setSidebarOpen(false)
  }

  const commitTitle = () => {
    if (!selectedNote) return
    const title = titleDraft.trim() || 'Untitled note'
    setTitleDraft(title)
    if (title === selectedNote.title) return
    noteCollection.update(selectedNote.id, (draft) => {
      draft.title = title
    })
  }

  const syncEverything = async () => {
    await noteCollection.utils.syncNow()
    await noteContent.flushAll()
  }

  return (
    <main className={sidebarOpen ? 'notes-app sidebar-visible' : 'notes-app'}>
      <aside className="notes-sidebar" aria-label="Notes">
        <header className="sidebar-header">
          <div className="wordmark">
            <span className="wordmark-seal">F</span>
            <div>
              <strong>Fieldnote</strong>
              <small>Notion journal</small>
            </div>
          </div>
          <button className="new-note" onClick={() => void createNote()}>
            <PlusIcon /> <span>New</span>
          </button>
        </header>

        <label className="search-field">
          <SearchIcon />
          <span className="sr-only">Search notes</span>
          <input
            ref={searchInput}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your writing"
          />
          {search ? <kbd>esc</kbd> : <kbd>⌘ k</kbd>}
        </label>

        <div className="list-heading">
          <span>{search ? 'Results' : 'All notes'}</span>
          <span>{visibleNotes.length}</span>
        </div>

        <div className="note-list">
          {isLoading ? <p className="list-message">Opening local notes…</p> : null}
          {!isLoading && visibleNotes.length === 0 ? (
            <div className="list-empty">
              <span>✦</span>
              <strong>{search ? 'No matching notes' : 'A blank notebook'}</strong>
              <p>{search ? 'Try another phrase.' : 'Write the first line.'}</p>
            </div>
          ) : null}
          {visibleNotes.map((note) => {
            const cached = noteContent.get(note.id)
            return (
              <button
                className={selectedId === note.id ? 'note-card is-selected' : 'note-card'}
                key={note.id}
                onClick={() => selectNote(note.id)}
              >
                <span className="note-card-topline">
                  <strong>{note.title || 'Untitled note'}</strong>
                  {note.pinned ? <span title="Pinned">◆</span> : null}
                </span>
                <span className="note-preview">{preview(cached?.markdown)}</span>
                <span className="note-card-meta">
                  <time>{formatDay(note.entryDate)}</time>
                  <span>{note.kind ?? 'Note'}</span>
                  {cached?.pending ? <i title="Saved locally" /> : null}
                </span>
              </button>
            )
          })}
        </div>

        <footer className="sidebar-footer">
          <span className={`network-mark status-${collectionSync.status}`} />
          <div>
            <strong>{collectionStatusLabel(collectionSync.status)}</strong>
            <small>{collectionStatusDetail(collectionSync)}</small>
          </div>
        </footer>
      </aside>

      <section className="editor-shell">
        <header className="editor-toolbar">
          <button
            className="mobile-back"
            onClick={() => setSidebarOpen(true)}
            aria-label="Back to notes"
          >
            <BackIcon /> Notes
          </button>
          <SyncLedger
            content={content}
            note={selectedNote}
            collection={collectionSync}
          />
          <div className="toolbar-actions">
            <button
              onClick={() => void syncEverything().catch(() => undefined)}
              disabled={collectionSync.status === 'syncing' || content?.status === 'syncing'}
            >
              Sync now
            </button>
            {selectedNote?.notionUrl ? (
              <a href={selectedNote.notionUrl} target="_blank" rel="noreferrer">
                Notion ↗
              </a>
            ) : null}
            {selectedNote ? (
              <button
                className="delete-note-button"
                onClick={() => {
                  if (
                    window.confirm(
                      `Move “${selectedNote.title || 'Untitled note'}” to Notion trash?`,
                    )
                  ) {
                    noteCollection.delete(selectedNote.id)
                  }
                }}
              >
                Delete
              </button>
            ) : null}
          </div>
        </header>

        {selectedNote ? (
          <article className="editor-page">
            <div className="editor-metadata">
              <span>{selectedNote.kind ?? 'Note'}</span>
              <time>{formatEditorDate(selectedNote.entryDate)}</time>
            </div>
            <input
              className="title-editor"
              aria-label="Note title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitTitle()
                  document.querySelector<HTMLTextAreaElement>('.content-editor')?.focus()
                }
              }}
            />

            <div className="metadata-controls">
              <label>
                <span>Kind</span>
                <select
                  value={selectedNote.kind ?? 'Note'}
                  onChange={(event) =>
                    noteCollection.update(selectedNote.id, (draft) => {
                      draft.kind = event.target.value as Note['kind']
                    })
                  }
                >
                  {noteKinds.map((kind) => (
                    <option key={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Entry date</span>
                <input
                  type="date"
                  value={selectedNote.entryDate?.slice(0, 10) ?? ''}
                  onChange={(event) =>
                    noteCollection.update(selectedNote.id, (draft) => {
                      draft.entryDate = event.target.value || null
                    })
                  }
                />
              </label>
              <label className="pin-control">
                <input
                  type="checkbox"
                  checked={selectedNote.pinned}
                  onChange={() =>
                    noteCollection.update(selectedNote.id, (draft) => {
                      draft.pinned = !draft.pinned
                    })
                  }
                />
                <span>Pin note</span>
              </label>
            </div>

            {content?.status === 'conflict' ? (
              <div className="conflict-banner" role="alert">
                <div>
                  <strong>Notion has another version.</strong>
                  <span>Your local draft is safe. Choose which copy to keep.</span>
                </div>
                <button onClick={() => void noteContent.acceptRemote(selectedNote.id)}>
                  Use Notion
                </button>
                <button
                  className="danger-action"
                  onClick={() =>
                    void noteContent.overwriteRemote(selectedNote.id, {
                      acceptDataLoss: true,
                    })
                  }
                >
                  Keep mine
                </button>
              </div>
            ) : null}

            {loadError ? <p className="editor-error">{loadError}</p> : null}
            <textarea
              className="content-editor"
              aria-label="Note content in Notion-flavored Markdown"
              value={content?.markdown ?? ''}
              onChange={(event) =>
                void noteContent.update(selectedNote.id, event.target.value).catch((error) => {
                  setLoadError(
                    error instanceof Error ? error.message : 'Could not save this draft.',
                  )
                })
              }
              onBlur={() => void noteContent.flush(selectedNote.id).catch(() => undefined)}
              disabled={
                !content ||
                content.status === 'loading' ||
                content.truncated ||
                content.unknownBlockIds.length > 0
              }
              placeholder={
                content
                  ? 'Begin anywhere…\n\nMarkdown shortcuts are preserved in Notion.'
                  : selectedNote.notionPageId
                    ? 'Opening this page…'
                    : 'Preparing a local draft…'
              }
              spellCheck
            />
            <footer className="editor-footnote">
              <span>Notion-flavored Markdown</span>
              <span>{content?.markdown.length ?? 0} characters</span>
            </footer>
          </article>
        ) : (
          <div className="no-selection">
            <span>F</span>
            <h1>Your notebook is ready.</h1>
            <p>Create a note. The first keystroke is saved here before it goes anywhere else.</p>
            <button onClick={() => void createNote()}>
              <PlusIcon /> Write a note
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
