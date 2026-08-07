import { useMemo, useState, type FormEvent } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import type { NotionSyncState } from 'tanstack-db-notion-adapter'
import { useNotionSyncState } from 'tanstack-db-notion-adapter/react'
import { todoCollection } from './collection'
import type {
  TodoSchemaInput,
  TodoSchemaRow,
} from './notion.generated'

type Filter = 'open' | 'all' | 'done'

const priorities = ['Low', 'Medium', 'High'] as const
function AddTodo() {
  const [title, setTitle] = useState('')

  function submit(event: FormEvent): void {
    event.preventDefault()
    const value = title.trim()
    if (!value) return
    const todo: TodoSchemaInput = { title: value }
    todoCollection.insert(todo)
    setTitle('')
  }

  return (
    <form className="add-todo" onSubmit={submit}>
      <input
        aria-label="New todo"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="New todo"
        autoComplete="off"
      />
      <button type="submit" disabled={!title.trim()}>
        Add
      </button>
    </form>
  )
}

function BlockedMutationNotice({
  blocked,
}: {
  blocked: NonNullable<NotionSyncState['blockedMutation']>
}) {
  const [busy, setBusy] = useState(false)
  const deleted = blocked.error.code === 'page_not_found'

  function run(action: () => Promise<unknown>): void {
    setBusy(true)
    void action()
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  return (
    <aside className="blocked" role="alert">
      <p>
        <strong>Could not save changes:</strong> {blocked.error.message}{' '}
        <code>{blocked.error.code}</code>
      </p>
      <div className="blocked-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(() => todoCollection.utils.retryPendingMutation(blocked.entryId))
          }
        >
          Retry
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(() =>
              todoCollection.utils.discardPendingMutation(blocked.entryId, {
                acceptDataLoss: true,
              }),
            )
          }
        >
          Discard local change
        </button>
        {deleted ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(() =>
                  todoCollection.utils.resolveDeletedMutation(blocked.entryId, {
                    action: 'recreate',
                  }),
                )
              }
            >
              Recreate in Notion
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(() =>
                  todoCollection.utils.resolveDeletedMutation(blocked.entryId, {
                    action: 'discard',
                    acceptDataLoss: true,
                  }),
                )
              }
            >
              Drop deleted row
            </button>
          </>
        ) : null}
      </div>
    </aside>
  )
}

function TodoRow({ todo }: { todo: TodoSchemaRow }) {
  return (
    <li className={todo.completed ? 'todo is-complete' : 'todo'}>
      <input
        type="checkbox"
        checked={todo.completed}
        aria-label={`Complete ${todo.title}`}
        onChange={() =>
          todoCollection.update(todo.id, (draft) => {
            draft.completed = !draft.completed
          })
        }
      />
      <span>{todo.title}</span>
      <select
        aria-label={`Priority for ${todo.title}`}
        value={todo.priority ?? 'Medium'}
        onChange={(event) =>
          todoCollection.update(todo.id, (draft) => {
            draft.priority = event.target.value as TodoSchemaRow['priority']
          })
        }
      >
        {priorities.map((priority) => (
          <option key={priority}>{priority}</option>
        ))}
      </select>
      <input
        className="due-date"
        type="date"
        aria-label={`Due date for ${todo.title}`}
        value={todo.dueDate?.slice(0, 10) ?? ''}
        onChange={(event) =>
          todoCollection.update(todo.id, (draft) => {
            draft.dueDate = event.target.value || null
          })
        }
      />
      {todo.notionUrl ? (
        <a href={todo.notionUrl} target="_blank" rel="noreferrer" aria-label="Open in Notion">
          ↗
        </a>
      ) : null}
      <button
        className="delete"
        type="button"
        onClick={() => todoCollection.delete(todo.id)}
        aria-label={`Delete ${todo.title}`}
      >
        ×
      </button>
    </li>
  )
}

export function App() {
  const [filter, setFilter] = useState<Filter>('open')
  const [limit, setLimit] = useState(20)
  const sync = useNotionSyncState(todoCollection)
  const { data: allTodos = [], isLoading } = useLiveQuery((query) =>
    query.from({ todo: todoCollection }),
  )
  const { data: todos = [] } = useLiveQuery(
    (query) => {
      const source = query.from({ todo: todoCollection })
      const filtered =
        filter === 'all'
          ? source
          : source.where(({ todo }) => eq(todo.completed, filter === 'done'))
      return filtered.orderBy(({ todo }) => todo.createdAt, 'desc').limit(limit)
    },
    [filter, limit],
  )
  const counts = useMemo(
    () => ({
      open: allTodos.filter((todo) => !todo.completed).length,
      all: allTodos.length,
      done: allTodos.filter((todo) => todo.completed).length,
    }),
    [allTodos],
  )
  const progress = sync.progress
  const syncLabel =
    progress?.phase === 'push'
      ? `${progress.completedMutations}/${progress.totalMutations} syncing`
      : progress?.phase === 'pull'
        ? `${progress.loadedRows} loaded`
        : sync.pendingMutations
          ? `${sync.pendingMutations} pending`
          : sync.status

  return (
    <main>
      <header>
        <h1>Todos</h1>
        <button
          className={`sync status-${sync.status}`}
          type="button"
          onClick={() => void todoCollection.utils.syncNow().catch(() => undefined)}
        >
          {syncLabel}
        </button>
      </header>

      {sync.error ? <p className="error">{sync.error}</p> : null}
      {sync.blockedMutation ? (
        <BlockedMutationNotice blocked={sync.blockedMutation} />
      ) : null}
      <AddTodo />

      <nav aria-label="Filter todos">
        {(['open', 'all', 'done'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={filter === value ? 'is-active' : ''}
            onClick={() => {
              setFilter(value)
              setLimit(20)
            }}
          >
            {value} <span>{counts[value]}</span>
          </button>
        ))}
      </nav>

      {isLoading ? <p className="empty">Loading…</p> : null}
      {!isLoading && todos.length === 0 ? <p className="empty">No todos</p> : null}
      <ul>
        {todos.map((todo) => (
          <TodoRow key={todo.id} todo={todo} />
        ))}
      </ul>

      {counts[filter] > limit ? (
        <button className="load-more" type="button" onClick={() => setLimit((value) => value + 20)}>
          Load more
        </button>
      ) : null}
    </main>
  )
}
