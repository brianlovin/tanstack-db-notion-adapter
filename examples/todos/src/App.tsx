import {
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { todoCollection } from './collection'
import { priorities, type Todo } from './todo-schema'
import type { NotionSyncState } from 'tanstack-db-notion-adapter'

type Filter = 'all' | 'open' | 'done'

const syncStateServerFallback: NotionSyncState = {
  status: 'idle',
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: 'memory',
  error: null,
  quarantine: null,
}

function useNotionSyncState(): NotionSyncState {
  return useSyncExternalStore(
    todoCollection.utils.subscribeSyncState,
    todoCollection.utils.getSyncState,
    () => syncStateServerFallback,
  )
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return 'Not yet synced'
  const seconds = Math.round((Date.now() - timestamp) / 1_000)
  if (seconds < 5) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

function formatDueDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(`${value.slice(0, 10)}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function connectionLabel(status: NotionSyncState['status']): string {
  switch (status) {
    case 'offline':
      return 'Offline'
    case 'error':
      return 'Sync error'
    case 'syncing':
    case 'hydrating':
      return 'Syncing'
    default:
      return 'Local-first'
  }
}

function remoteLabel(state: NotionSyncState): string {
  switch (state.status) {
    case 'offline':
      return 'Waiting for network'
    case 'error':
      return 'Needs attention'
    case 'syncing':
    case 'hydrating':
      return 'Reconciling'
    default:
      return formatTime(state.lastSyncedAt)
  }
}

function CloudIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.4 18.2h9.2a4.4 4.4 0 0 0 .8-8.7A6 6 0 0 0 6.1 8.2a5 5 0 0 0 1.3 10Z" />
      <path d="m9.4 13.2 1.8 1.8 3.8-4" />
    </svg>
  )
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="7.5" ry="3" />
      <path d="M4.5 5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5M4.5 11v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  )
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6" />
    </svg>
  )
}

function AddTodo() {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<(typeof priorities)[number]>('Medium')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextTitle = title.trim()
    if (!nextTitle) return
    todoCollection.insert({ title: nextTitle, priority })
    setTitle('')
  }

  return (
    <form className="composer" onSubmit={submit}>
      <span className="composer-mark" aria-hidden="true">
        +
      </span>
      <label className="sr-only" htmlFor="new-todo">
        Add a task
      </label>
      <input
        id="new-todo"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Add something worth finishing…"
        autoComplete="off"
      />
      <label className="sr-only" htmlFor="new-priority">
        Priority
      </label>
      <select
        id="new-priority"
        value={priority}
        onChange={(event) =>
          setPriority(event.target.value as (typeof priorities)[number])
        }
      >
        {priorities.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <button type="submit" disabled={!title.trim()}>
        Add task <ArrowIcon />
      </button>
    </form>
  )
}

function TodoRow({ todo, index }: { todo: Todo; index: number }) {
  return (
    <li className={todo.completed ? 'todo-row is-complete' : 'todo-row'}>
      <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
      <label className="check-wrap">
        <input
          type="checkbox"
          checked={todo.completed}
          onChange={() =>
            todoCollection.update(todo.id, (draft) => {
              draft.completed = !draft.completed
            })
          }
        />
        <span className="custom-check" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="m3 8 3 3 7-7" />
          </svg>
        </span>
        <span className="sr-only">Mark {todo.title} complete</span>
      </label>
      <div className="todo-copy">
        <span className="todo-title">{todo.title}</span>
        <span className="todo-meta">
          {todo.notionPageId ? 'Notion page' : 'Local draft'}
          {todo.dueDate ? ` · due ${formatDueDate(todo.dueDate)}` : ''}
        </span>
      </div>
      <select
        className={`priority priority-${todo.priority?.toLowerCase() ?? 'none'}`}
        aria-label={`Priority for ${todo.title}`}
        value={todo.priority ?? ''}
        onChange={(event) =>
          todoCollection.update(todo.id, (draft) => {
            draft.priority = event.target.value as Todo['priority']
          })
        }
      >
        {priorities.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      {todo.notionUrl ? (
        <a
          className="icon-button notion-link"
          href={todo.notionUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${todo.title} in Notion`}
        >
          <ExternalIcon />
        </a>
      ) : (
        <span className="icon-button placeholder-icon" aria-hidden="true" />
      )}
      <button
        className="icon-button delete-button"
        onClick={() => todoCollection.delete(todo.id)}
        aria-label={`Delete ${todo.title}`}
      >
        <TrashIcon />
      </button>
    </li>
  )
}

function SyncRail({ state }: { state: NotionSyncState }) {
  const active = state.status === 'syncing' || state.status === 'hydrating'

  return (
    <aside className="sync-rail" aria-label="Sync pipeline">
      <div className="rail-heading">
        <span>Sync pipeline</span>
        <span className={active ? 'live-dot is-active' : 'live-dot'} />
      </div>
      <div className="rail-track" aria-hidden="true">
        <span className={active ? 'data-packet is-moving' : 'data-packet'} />
      </div>
      <div className="rail-stage">
        <span className="stage-icon">
          <DatabaseIcon />
        </span>
        <div>
          <strong>Local cache</strong>
          <small>{state.storage}</small>
        </div>
        <span className="stage-state is-ready">Ready</span>
      </div>
      <div className="rail-stage">
        <span className="stage-number">02</span>
        <div>
          <strong>Outbox</strong>
          <small>Durable writes</small>
        </div>
        <span className={state.pendingMutations ? 'stage-state is-pending' : 'stage-state'}>
          {state.pendingMutations}
        </span>
      </div>
      <div className="rail-stage">
        <span className="stage-icon">
          <CloudIcon />
        </span>
        <div>
          <strong>Notion</strong>
          <small>{remoteLabel(state)}</small>
        </div>
        <span
          className={`stage-state remote-state status-${state.status}`}
          title={state.status}
        />
      </div>
      <div className="rail-note">
        <span>Network is off the interaction path.</span>
        <p>Every edit lands here first, then moves upstream when it can.</p>
      </div>
    </aside>
  )
}

interface TodoResultsProps {
  filter: Filter
  isLoading: boolean
  todos: Array<Todo>
}

function TodoResults({ filter, isLoading, todos }: TodoResultsProps) {
  if (isLoading) {
    return (
      <div className="empty-state">
        <span className="empty-glyph is-loading" />
        <strong>Opening the local cache…</strong>
      </div>
    )
  }

  if (todos.length === 0) {
    const heading = filter === 'all' ? 'The ledger is clear.' : `No ${filter} tasks.`
    const description =
      filter === 'all'
        ? 'Add a task above. It works without a connection.'
        : 'Choose another view to keep looking.'
    return (
      <div className="empty-state">
        <span className="empty-glyph">✓</span>
        <strong>{heading}</strong>
        <p>{description}</p>
      </div>
    )
  }

  return (
    <ul className="todo-list">
      {todos.map((todo, index) => (
        <TodoRow key={todo.id} todo={todo} index={index} />
      ))}
    </ul>
  )
}

export function App() {
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(8)
  const state = useNotionSyncState()
  const { data: allTodos = [], isLoading } = useLiveQuery((query) =>
    query
      .from({ todo: todoCollection })
      .orderBy(({ todo }) => todo.createdAt, 'desc'),
  )
  const { data: todos = [] } = useLiveQuery(
    (query) => {
      const base = query.from({ todo: todoCollection })
      const filtered =
        filter === 'all'
          ? base
          : base.where(({ todo }) => eq(todo.completed, filter === 'done'))
      return filtered
        .orderBy(({ todo }) => todo.createdAt, 'desc')
        .limit(limit)
    },
    [filter, limit],
  )

  const counts = useMemo(
    () => ({
      all: allTodos.length,
      open: allTodos.filter((todo) => !todo.completed).length,
      done: allTodos.filter((todo) => todo.completed).length,
    }),
    [allTodos],
  )
  const filteredCount = counts[filter]

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Relay home">
          <span className="brand-mark"><span /></span>
          <span>Relay</span>
          <small>Notion × TanStack DB</small>
        </a>
        <div className="topbar-actions">
          <span className={`connection-pill status-${state.status}`}>
            <span />
            {connectionLabel(state.status)}
          </span>
          <button
            className="sync-button"
            onClick={() => void todoCollection.utils.syncNow().catch(() => undefined)}
            disabled={state.status === 'syncing' || state.status === 'hydrating'}
          >
            <CloudIcon /> Sync now
          </button>
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">Your Notion database, at local speed</p>
          <h1>Things to move forward.</h1>
        </div>
        <p className="intro-copy">
          Add, finish, and reorganize work instantly. Relay keeps a durable local
          copy and catches Notion up in the background.
        </p>
      </section>

      {state.error ? (
        <div className="error-banner" role="alert">
          <div>
            <strong>Sync stopped</strong>
            <span>{state.error}</span>
          </div>
          <button
            onClick={() => void todoCollection.utils.syncNow().catch(() => undefined)}
          >
            Try again
          </button>
        </div>
      ) : null}

      <section className="workspace">
        <SyncRail state={state} />
        <div className="ledger">
          <AddTodo />
          <div className="ledger-toolbar">
            <div className="filters" aria-label="Filter tasks">
              {(['all', 'open', 'done'] as const).map((value) => (
                <button
                  key={value}
                  className={filter === value ? 'is-selected' : ''}
                  onClick={() => {
                    setFilter(value)
                    setLimit(8)
                  }}
                >
                  {value[0]!.toUpperCase() + value.slice(1)}
                  <span>{counts[value]}</span>
                </button>
              ))}
            </div>
            <span className="query-note">Live query · {filteredCount} rows</span>
          </div>

          <TodoResults filter={filter} isLoading={isLoading} todos={todos} />

          <footer className="ledger-footer">
            <span>
              {counts.open} {counts.open === 1 ? 'task' : 'tasks'} left
            </span>
            {filteredCount > limit ? (
              <button onClick={() => setLimit((value) => value + 8)}>
                Show 8 more
              </button>
            ) : (
              <span>End of local result set</span>
            )}
          </footer>
        </div>
      </section>

      <footer className="page-footer">
        <span>TanStack DB renders from memory.</span>
        <span>IndexedDB survives refreshes.</span>
        <span>Notion remains the shared source.</span>
      </footer>
    </main>
  )
}
