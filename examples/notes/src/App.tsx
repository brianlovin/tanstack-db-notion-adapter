import { useEffect, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import type {
  NotionPageContentSnapshot,
  NotionSyncState,
} from 'tanstack-db-notion-adapter'
import { noteCollection } from './collection'
import { noteContent } from './content'
import type {
  NoteSchemaInput,
  NoteSchemaRow,
} from './note-schema.generated'

const noteKinds = ['Note', 'Journal'] as const
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const syncFallback: NotionSyncState = {
  status: 'idle',
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: 'memory',
  error: null,
  quarantine: null,
}

function useSyncState(): NotionSyncState {
  return useSyncExternalStore(
    noteCollection.utils.subscribeSyncState,
    noteCollection.utils.getSyncState,
    () => syncFallback,
  )
}

function usePageContent(key: string | null): NotionPageContentSnapshot | undefined {
  return useSyncExternalStore(
    noteContent.subscribe,
    () => (key ? noteContent.get(key) : undefined),
    () => undefined,
  )
}

function today(): string {
  const date = new Date()
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
}

function formatDate(value: string | null): string {
  if (!value) return 'No date'
  return dateFormatter.format(new Date(`${value.slice(0, 10)}T12:00:00`))
}

function contentStatus(content: NotionPageContentSnapshot | undefined): string {
  if (!content) return 'Loading'
  if (content.status === 'saved-local') return 'Saved locally'
  if (content.status === 'syncing') return 'Syncing'
  if (content.status === 'synced') return 'Synced'
  return content.status
}

interface NoteEditorProps {
  note: NoteSchemaRow
  content: NotionPageContentSnapshot | undefined
  error: string | null
  onError: (message: string | null) => void
}

function NoteEditor({ note, content, error, onError }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title)
  const readOnly =
    !content ||
    content.status === 'loading' ||
    content.truncated ||
    content.unknownBlockIds.length > 0

  function saveTitle(): void {
    const value = title.trim() || 'Untitled'
    setTitle(value)
    if (value === note.title) return
    noteCollection.update(note.id, (draft) => {
      draft.title = value
    })
  }

  return (
    <article>
      <input
        className="title"
        aria-label="Note title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
      />

      <div className="properties">
        <select
          aria-label="Note kind"
          value={note.kind ?? 'Note'}
          onChange={(event) =>
            noteCollection.update(note.id, (draft) => {
              draft.kind = event.target.value as NoteSchemaRow['kind']
            })
          }
        >
          {noteKinds.map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
        <input
          type="date"
          aria-label="Entry date"
          value={note.entryDate?.slice(0, 10) ?? ''}
          onChange={(event) =>
            noteCollection.update(note.id, (draft) => {
              draft.entryDate = event.target.value || null
            })
          }
        />
        <label>
          <input
            type="checkbox"
            checked={note.pinned}
            onChange={() =>
              noteCollection.update(note.id, (draft) => {
                draft.pinned = !draft.pinned
              })
            }
          />
          Pinned
        </label>
      </div>

      {content?.status === 'conflict' ? (
        <div className="notice" role="alert">
          <span>Notion has another version.</span>
          <button type="button" onClick={() => void noteContent.acceptRemote(note.id)}>
            Use Notion
          </button>
          <button
            type="button"
            onClick={() => void noteContent.overwriteRemote(note.id, { acceptDataLoss: true })}
          >
            Keep mine
          </button>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <textarea
        aria-label="Note content"
        value={content?.markdown ?? ''}
        disabled={readOnly}
        placeholder={content ? 'Write…' : 'Loading…'}
        onChange={(event) => {
          onError(null)
          void noteContent.update(note.id, event.target.value).catch((caught) => {
            onError(caught instanceof Error ? caught.message : 'Could not save the note.')
          })
        }}
        onBlur={() => void noteContent.flush(note.id).catch(() => undefined)}
      />
    </article>
  )
}

export function App() {
  const sync = useSyncState()
  const { data: notes = [], isLoading } = useLiveQuery((query) =>
    query.from({ note: noteCollection }).orderBy(({ note }) => note.updatedAt, 'desc'),
  )
  const [requestedId, setRequestedId] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const selectedNote = notes.find((note) => note.id === requestedId) ?? notes[0]
  const selectedId = selectedNote?.id ?? null
  const content = usePageContent(selectedId)

  useEffect(() => {
    if (!selectedNote) return
    let active = true
    setError(null)
    const open = selectedNote.notionPageId
      ? noteContent.attachPage(selectedNote.id, selectedNote.notionPageId)
      : noteContent.createDraft(selectedNote.id)
    void open.catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : 'Could not open the note.')
    })
    return () => {
      active = false
      void noteContent.flush(selectedNote.id).catch(() => undefined)
    }
  }, [selectedNote?.id, selectedNote?.notionPageId])

  async function createNote(): Promise<void> {
    const id = crypto.randomUUID()
    const input: NoteSchemaInput = {
      id,
      title: 'Untitled',
      kind: 'Note',
      entryDate: today(),
    }
    await noteContent.createDraft(id)
    noteCollection.insert(input)
    setRequestedId(id)
    setShowList(false)
  }

  function selectNote(id: string): void {
    if (selectedId && selectedId !== id) void noteContent.flush(selectedId).catch(() => undefined)
    setRequestedId(id)
    setShowList(false)
  }

  return (
    <main className={showList ? 'show-list' : ''}>
      <aside aria-label="Notes">
        <header>
          <h1>Notes</h1>
          <button type="button" onClick={() => void createNote()}>
            New
          </button>
        </header>
        <div className="note-list">
          {isLoading ? <p>Loading…</p> : null}
          {!isLoading && notes.length === 0 ? <p>No notes</p> : null}
          {notes.map((note) => (
            <button
              type="button"
              key={note.id}
              className={note.id === selectedId ? 'note is-active' : 'note'}
              onClick={() => selectNote(note.id)}
            >
              <strong>{note.title || 'Untitled'}</strong>
              <span>{formatDate(note.entryDate)}</span>
            </button>
          ))}
        </div>
        <button
          className={`sync status-${sync.status}`}
          type="button"
          onClick={() =>
            void Promise.all([noteCollection.utils.syncNow(), noteContent.flushAll()]).catch(
              () => undefined,
            )
          }
        >
          {sync.status} · {contentStatus(content)}
        </button>
      </aside>

      <section className="editor">
        <header>
          <button className="back" type="button" onClick={() => setShowList(true)}>
            Notes
          </button>
          <div>
            {selectedNote?.notionUrl ? (
              <a href={selectedNote.notionUrl} target="_blank" rel="noreferrer">
                Notion ↗
              </a>
            ) : null}
            {selectedNote ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete “${selectedNote.title || 'Untitled'}”?`)) {
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
          <NoteEditor
            key={selectedNote.id}
            note={selectedNote}
            content={content}
            error={error}
            onError={setError}
          />
        ) : (
          <p className="empty">Create a note</p>
        )}
      </section>
    </main>
  )
}
