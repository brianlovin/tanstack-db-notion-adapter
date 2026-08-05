import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  ChevronsUpDown,
  Cloud,
  CloudOff,
  Inbox,
  Layers3,
  ListTodo,
  LockKeyhole,
  Star,
  Sun,
} from "lucide-react";
import { createTodoWorkspace, type TodoWorkspace } from "./collection";
import { TaskList } from "./components/TaskList";
import {
  positionsForBlockMove,
  selectionRange,
  taskCounts,
  views,
  visibleTasks,
  type Todo,
  type TodoView,
} from "./domain";
import { useNotionSyncState, useSession } from "./hooks";
import { afterCompletionHold } from "./interactions";
import { isTextEntryTarget, keyboardCommand, viewFromTravelKey } from "./keyboard";

const CommandPalette = lazy(() => import("./components/CommandPalette"));
const ShortcutGuide = lazy(() => import("./components/ShortcutGuide"));
const EDITOR_CLOSE_MS = 180;

const viewIcons = {
  inbox: Inbox,
  today: Star,
  upcoming: CalendarDays,
  anytime: Layers3,
  someday: Archive,
  logbook: CheckCircle2,
  all: ListTodo,
} as const;

function initialView(): TodoView {
  const value = new URLSearchParams(location.search).get("view");
  return views.some((view) => view.id === value) ? (value as TodoView) : "today";
}

function initialTask(): string | null {
  return new URLSearchParams(location.search).get("task");
}

function editorFieldSelector(focus: "deadline" | "title" | "when"): string {
  switch (focus) {
    case "deadline":
      return "[data-task-deadline]";
    case "when":
      return "[data-task-when]";
    case "title":
      return "[data-task-title]";
  }
}

function nextTaskOutsideSelection(
  todos: ReadonlyArray<Todo>,
  selectedIds: ReadonlySet<string>,
  focusedId: string,
): Todo | null {
  const focusedIndex = todos.findIndex((todo) => todo.id === focusedId);
  return (
    todos.slice(focusedIndex + 1).find((todo) => !selectedIds.has(todo.id)) ??
    [...todos]
      .slice(0, focusedIndex)
      .reverse()
      .find((todo) => !selectedIds.has(todo.id)) ??
    null
  );
}

function Login({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="login-mark">
          <Sun size={24} />
        </span>
        <p className="eyebrow">Your private workspace</p>
        <h1>Welcome to Daylight</h1>
        <p>Unlock the fast local workspace connected to your Notion tasks.</p>
        <form onSubmit={submit}>
          <label>
            Password
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button disabled={submitting || !password}>
            <LockKeyhole size={16} />
            {submitting ? "Unlocking…" : "Unlock workspace"}
          </button>
        </form>
      </div>
    </main>
  );
}

function Workspace({
  workspace,
  developmentBypass,
  onLogout,
}: {
  workspace: TodoWorkspace;
  developmentBypass: boolean;
  onLogout: () => void;
}) {
  const [firstTask] = useState(initialTask);
  const [view, setView] = useState<TodoView>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(firstTask);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(firstTask ? [firstTask] : []),
  );
  const [editingId, setEditingId] = useState<string | null>(firstTask);
  const [closingEditorId, setClosingEditorId] = useState<string | null>(null);
  const [editingFocus, setEditingFocus] = useState<"deadline" | "title" | "when">("title");
  const [composer, setComposer] = useState({ open: false, afterId: null as string | null });
  const [palette, setPalette] = useState({ open: false, query: "" });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [travelOpen, setTravelOpen] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const quickEntry = useRef<HTMLInputElement>(null);
  const bulkWhen = useRef<HTMLInputElement>(null);
  const bulkDeadline = useRef<HTMLInputElement>(null);
  const viewSwitcher = useRef<HTMLDetailsElement>(null);
  const selectionAnchor = useRef<string | null>(firstTask);
  const selectedIdRef = useRef<string | null>(firstTask);
  const completionTimers = useRef<Set<number>>(new Set());
  const editorCloseTimer = useRef<number | null>(null);
  const sync = useNotionSyncState(workspace);
  const { data: allTodos, isLoading } = useLiveQuery((query) =>
    query.from({ todo: workspace.collection }),
  );
  const todos = useMemo(() => visibleTasks(allTodos, view, ""), [allTodos, view]);
  const counts = useMemo(() => taskCounts(allTodos), [allTodos]);
  const selected = allTodos.find((todo) => todo.id === selectedId) ?? null;

  const clearSelection = () => {
    selectionAnchor.current = null;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedIds(new Set());
  };
  const selectTask = (id: string) => {
    selectionAnchor.current = id;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelectedIds(new Set([id]));
  };
  const extendSelection = (id: string) => {
    const anchor = selectionAnchor.current ?? selectedId ?? id;
    selectionAnchor.current = anchor;
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelectedIds(
      selectionRange(
        todos.map((todo) => todo.id),
        anchor,
        id,
      ),
    );
  };

  const focusTaskRow = (id: string | null) => {
    if (!id) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)?.focus();
    });
  };
  const closeEditor = (restoreFocus = true) => {
    const id = editingId;
    if (!id) return;
    if (editorCloseTimer.current !== null) window.clearTimeout(editorCloseTimer.current);
    setClosingEditorId(id);
    editorCloseTimer.current = window.setTimeout(() => {
      setEditingId((current) => (current === id ? null : current));
      setClosingEditorId((current) => (current === id ? null : current));
      if (restoreFocus) focusTaskRow(id);
      editorCloseTimer.current = null;
    }, EDITOR_CLOSE_MS);
  };
  const openEditor = (id: string, focus: "deadline" | "title" | "when" = "title") => {
    if (editorCloseTimer.current !== null) window.clearTimeout(editorCloseTimer.current);
    editorCloseTimer.current = null;
    setClosingEditorId(null);
    selectTask(id);
    setComposer({ open: false, afterId: null });
    setEditingFocus(focus);
    setEditingId(id);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(editorFieldSelector(focus))?.focus();
    });
  };
  const openComposer = (afterId: string | null) => {
    setEditingId(null);
    setComposer({ open: true, afterId });
    requestAnimationFrame(() => quickEntry.current?.focus());
  };
  const stageCompletion = (ids: ReadonlyArray<string>, nextId: string | null) => {
    const pendingIds = ids.filter((id) => !completingIds.has(id));
    if (pendingIds.length === 0) return;
    setCompletingIds((current) => new Set([...current, ...pendingIds]));
    const timer = afterCompletionHold(() => {
      for (const id of pendingIds) {
        workspace.collection.update(id, (draft) => {
          draft.completed = true;
          draft.completedAt = new Date().toISOString();
        });
      }
      setCompletingIds((current) => {
        const next = new Set(current);
        for (const id of pendingIds) next.delete(id);
        return next;
      });
      setEditingId((current) => (current && pendingIds.includes(current) ? null : current));
      setClosingEditorId((current) => (current && pendingIds.includes(current) ? null : current));
      if (pendingIds.includes(selectedIdRef.current ?? "")) {
        if (nextId) selectTask(nextId);
        else clearSelection();
        focusTaskRow(nextId);
      }
      completionTimers.current.delete(timer);
    });
    completionTimers.current.add(timer);
  };
  const toggleTodo = (todo: Todo) => {
    if (!todo.completed) {
      const next = nextTaskOutsideSelection(todos, new Set([todo.id]), todo.id);
      stageCompletion([todo.id], next?.id ?? null);
      return;
    }
    workspace.collection.update(todo.id, (draft) => {
      draft.completed = false;
      draft.completedAt = null;
    });
  };
  const completeSelected = () => {
    if (!selected || selectedIds.size === 0) return;
    const next = nextTaskOutsideSelection(todos, selectedIds, selected.id);
    const completing = [...selectedIds].some(
      (id) => !allTodos.find((todo) => todo.id === id)?.completed,
    );
    if (completing) {
      setEditingId(null);
      stageCompletion([...selectedIds], next?.id ?? null);
      return;
    }
    for (const id of selectedIds) {
      workspace.collection.update(id, (draft) => {
        draft.completed = false;
        draft.completedAt = null;
      });
    }
    setEditingId(null);
    if (next) selectTask(next.id);
    else clearSelection();
    focusTaskRow(next?.id ?? null);
  };
  const moveSelected = (direction: -1 | 1) => {
    if (!selected) return;
    const positions = positionsForBlockMove(todos, selectedIds, direction);
    for (const [id, position] of positions) {
      workspace.collection.update(id, (draft) => {
        draft.position = position;
      });
    }
    focusTaskRow(selected.id);
  };
  const openDateAction = (field: "deadline" | "when") => {
    if (!selectedId) return;
    if (selectedIds.size === 1) {
      openEditor(selectedId, field);
      return;
    }
    const input = field === "when" ? bulkWhen.current : bulkDeadline.current;
    input?.showPicker();
  };
  const applyDateToSelection = (field: "deadline" | "scheduledFor", value: string) => {
    if (!value) return;
    for (const id of selectedIds) {
      workspace.collection.update(id, (draft) => {
        draft[field] = value;
      });
    }
  };
  const changeView = (next: TodoView) => {
    if (editorCloseTimer.current !== null) window.clearTimeout(editorCloseTimer.current);
    editorCloseTimer.current = null;
    setView(next);
    clearSelection();
    setEditingId(null);
    setClosingEditorId(null);
    setComposer({ open: false, afterId: null });
    if (viewSwitcher.current) viewSwitcher.current.open = false;
  };

  useEffect(() => {
    const parameters = new URLSearchParams(location.search);
    parameters.set("view", view);
    if (editingId) parameters.set("task", editingId);
    else parameters.delete("task");
    history.replaceState(null, "", `${location.pathname}?${parameters}`);
  }, [editingId, view]);

  useEffect(() => {
    if (!travelOpen) return;
    const timeout = window.setTimeout(() => setTravelOpen(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [travelOpen]);

  useEffect(
    () => () => {
      for (const timer of completionTimers.current) window.clearTimeout(timer);
      if (editorCloseTimer.current !== null) window.clearTimeout(editorCloseTimer.current);
    },
    [],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (travelOpen && !isTextEntryTarget(event.target)) {
        const destination = viewFromTravelKey(event.key);
        if (destination) {
          event.preventDefault();
          setTravelOpen(false);
          changeView(destination);
          return;
        }
        if (event.key.length === 1) setTravelOpen(false);
      }
      const command = keyboardCommand(event);
      if (!command) return;
      event.preventDefault();
      switch (command.type) {
        case "begin-travel":
          setTravelOpen(true);
          break;
        case "close":
          if (palette.open) setPalette((current) => ({ ...current, open: false }));
          else if (shortcutsOpen) setShortcutsOpen(false);
          else if (viewSwitcher.current?.open) viewSwitcher.current.open = false;
          else if (editingId) closeEditor();
          else if (composer.open) setComposer({ open: false, afterId: null });
          else clearSelection();
          break;
        case "complete":
          completeSelected();
          break;
        case "create":
          openComposer(command.belowSelection ? selectedId : null);
          break;
        case "focus-deadline":
          openDateAction("deadline");
          break;
        case "focus-when":
          openDateAction("when");
          break;
        case "move":
          moveSelected(command.direction);
          break;
        case "open":
          if (selectedId) openEditor(selectedId);
          break;
        case "search":
          setTravelOpen(false);
          setShortcutsOpen(false);
          setPalette({ open: true, query: command.query ?? "" });
          break;
        case "show-shortcuts":
          setTravelOpen(false);
          setPalette((current) => ({ ...current, open: false }));
          setShortcutsOpen(true);
          break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  const currentView = views.find((candidate) => candidate.id === view)!;
  const ViewIcon = viewIcons[view];

  return (
    <main className={editingId ? "app-shell is-focused" : "app-shell"}>
      <section
        className="workspace-list"
        onPointerDown={(event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (editingId && !target.closest(".task-editor")) closeEditor(false);
          if (!target.closest(".task-row, .task-editor, .quick-entry, .bulk-date-picker")) {
            clearSelection();
          }
        }}
      >
        <header className="top-bar">
          {developmentBypass ? (
            <span className="top-bar-spacer" />
          ) : (
            <button className="top-control" onClick={onLogout} aria-label="Lock workspace">
              <LockKeyhole />
            </button>
          )}
          <details ref={viewSwitcher} className="view-switcher">
            <summary>
              {currentView.label}
              <ChevronsUpDown />
            </summary>
            <nav className="view-menu" aria-label="Choose a list">
              {views.map((destination) => {
                const DestinationIcon = viewIcons[destination.id];
                return (
                  <button
                    key={destination.id}
                    className={destination.id === view ? "is-active" : undefined}
                    onClick={() => changeView(destination.id)}
                  >
                    <DestinationIcon />
                    <span>{destination.label}</span>
                    {counts[destination.id] > 0 && <small>{counts[destination.id]}</small>}
                  </button>
                );
              })}
            </nav>
          </details>
          <button
            className={`top-control top-sync status-${sync.status}`}
            onClick={() => void workspace.collection.utils.syncNow()}
            aria-label={sync.error ? `Sync error: ${sync.error}` : `Notion sync: ${sync.status}`}
          >
            {sync.status === "offline" ? <CloudOff /> : <Cloud />}
            <span aria-hidden="true" />
          </button>
        </header>

        <header className="list-header">
          <div className="list-heading">
            <span className={`view-mark view-mark-${view}`} aria-hidden="true">
              <ViewIcon />
            </span>
            <h1>{currentView.label}</h1>
          </div>
        </header>

        {sync.error && (
          <div className="sync-error-banner">
            <span>{sync.error}</span>
            <button onClick={() => void workspace.collection.utils.syncNow()}>Try again</button>
          </div>
        )}

        <TaskList
          workspace={workspace}
          todos={todos}
          view={view}
          selectedIds={selectedIds}
          completingIds={completingIds}
          editingId={editingId}
          closingEditorId={closingEditorId}
          editingFocus={editingFocus}
          composer={composer}
          isLoading={isLoading}
          onSelect={selectTask}
          onExtendSelection={extendSelection}
          onOpen={openEditor}
          onComplete={completeSelected}
          onToggleComplete={toggleTodo}
          onCloseEditor={closeEditor}
          onCreateBelow={openComposer}
          onCreated={(id) => {
            setComposer({ open: false, afterId: null });
            openEditor(id);
          }}
          onDismissComposer={() => {
            setComposer({ open: false, afterId: null });
            focusTaskRow(selectedId);
          }}
          quickEntryRef={quickEntry}
        />

        {selectedIds.size > 1 && (
          <>
            <input
              ref={bulkWhen}
              className="bulk-date-picker"
              type="date"
              tabIndex={-1}
              aria-label="Schedule selected tasks"
              onChange={(event) => {
                applyDateToSelection("scheduledFor", event.target.value);
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={bulkDeadline}
              className="bulk-date-picker"
              type="date"
              tabIndex={-1}
              aria-label="Set deadline for selected tasks"
              onChange={(event) => {
                applyDateToSelection("deadline", event.target.value);
                event.currentTarget.value = "";
              }}
            />
          </>
        )}

        {travelOpen && (
          <div className="travel-hint" role="status">
            <strong>Go to</strong>
            {views.map((destination) => (
              <span key={destination.id}>
                <kbd>{destination.travelKey}</kbd> {destination.label}
              </span>
            ))}
          </div>
        )}
      </section>

      {palette.open && (
        <Suspense fallback={null}>
          <CommandPalette
            open
            query={palette.query}
            todos={allTodos}
            onQuery={(query) => setPalette({ open: true, query })}
            onClose={() => setPalette((current) => ({ ...current, open: false }))}
            onView={changeView}
            onTask={(todo: Todo) => {
              setView("all");
              openEditor(todo.id);
            }}
          />
        </Suspense>
      )}
      {shortcutsOpen && (
        <Suspense fallback={null}>
          <ShortcutGuide open onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      )}
    </main>
  );
}

export function App() {
  const { session, error, login, logout } = useSession();
  const [workspace, setWorkspace] = useState<TodoWorkspace | null>(null);

  useEffect(() => {
    if (!session?.authenticated) {
      setWorkspace(null);
      return;
    }
    const next = createTodoWorkspace();
    setWorkspace(next);
    return () => next.cleanup();
  }, [session?.authenticated]);

  if (error) {
    return (
      <main className="fatal-state">
        <CloudOff />
        <h1>Daylight cannot reach its server</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="boot-screen">
        <span className="loading-ring" />
        <span>Opening Daylight…</span>
      </main>
    );
  }
  if (!session.authenticated) return <Login onLogin={login} />;
  if (!workspace) {
    return (
      <main className="boot-screen">
        <span className="loading-ring" />
        <span>Loading your local workspace…</span>
      </main>
    );
  }
  return (
    <Workspace
      workspace={workspace}
      developmentBypass={session.developmentBypass}
      onLogout={() => void logout()}
    />
  );
}
