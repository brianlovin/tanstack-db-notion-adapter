import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { CloudOff, LockKeyhole, Menu, RotateCw, Sun } from "lucide-react";
import { createTodoWorkspace, type TodoWorkspace } from "./collection";
import { QuickEntry } from "./components/QuickEntry";
import { Sidebar } from "./components/Sidebar";
import { TaskInspector } from "./components/TaskInspector";
import { TaskList } from "./components/TaskList";
import { taskCounts, views, visibleTasks, type TodoView } from "./domain";
import { useNotionSyncState, useSession } from "./hooks";

function initialView(): TodoView {
  const value = new URLSearchParams(location.search).get("view");
  return views.some((view) => view.id === value) ? (value as TodoView) : "today";
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
  const [view, setView] = useState<TodoView>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("task"),
  );
  const [search, setSearch] = useState("");
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const quickEntry = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const sync = useNotionSyncState(workspace);
  const { data: allTodos, isLoading } = useLiveQuery((query) =>
    query.from({ todo: workspace.collection }),
  );
  const todos = useMemo(
    () => visibleTasks(allTodos, view, deferredSearch),
    [allTodos, view, deferredSearch],
  );
  const counts = useMemo(() => taskCounts(allTodos), [allTodos]);
  const selected = allTodos.find((todo) => todo.id === selectedId) ?? null;

  useEffect(() => {
    const parameters = new URLSearchParams(location.search);
    parameters.set("view", view);
    if (selectedId) parameters.set("task", selectedId);
    else parameters.delete("task");
    history.replaceState(null, "", `${location.pathname}?${parameters}`);
  }, [view, selectedId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "n") {
        event.preventDefault();
        quickEntry.current?.focus();
        return;
      }
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-search-input]")?.focus();
        return;
      }
      if (command) {
        const target = views.find((candidate) => candidate.shortcut === event.key);
        if (target) {
          event.preventDefault();
          setView(target.id);
          setMobileNavigation(false);
        }
      } else if (event.key === "Escape") {
        setSelectedId(null);
        setMobileNavigation(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const currentView = views.find((candidate) => candidate.id === view)!;
  const changeView = (next: TodoView) => {
    setView(next);
    setSelectedId(null);
    setMobileNavigation(false);
  };

  return (
    <main className={`app-shell${selected ? " has-inspector" : ""}`}>
      <div className={mobileNavigation ? "sidebar-shell is-open" : "sidebar-shell"}>
        <button
          className="mobile-scrim"
          onClick={() => setMobileNavigation(false)}
          aria-label="Close navigation"
        />
        <Sidebar
          view={view}
          counts={counts}
          search={search}
          sync={sync}
          developmentBypass={developmentBypass}
          onView={changeView}
          onSearch={setSearch}
          onSync={() => void workspace.collection.utils.syncNow()}
          onLogout={onLogout}
        />
      </div>

      <section className={selected ? "workspace-list mobile-hidden" : "workspace-list"}>
        <header className="list-header">
          <button
            className="mobile-menu"
            onClick={() => setMobileNavigation(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </button>
          <div>
            <p>
              {view === "today"
                ? new Intl.DateTimeFormat(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  }).format(new Date())
                : "Your tasks"}
            </p>
            <h1>{currentView.label}</h1>
          </div>
          <div className="header-status" title={sync.error ?? undefined}>
            {sync.status === "offline" ? (
              <CloudOff />
            ) : (
              <RotateCw className={sync.status === "syncing" ? "is-spinning" : ""} />
            )}
            <span>
              {sync.pendingMutations
                ? `${sync.pendingMutations} pending`
                : sync.status === "synced"
                  ? "Synced"
                  : sync.status}
            </span>
          </div>
        </header>
        <QuickEntry
          ref={quickEntry}
          collection={workspace.collection}
          todos={allTodos}
          view={view}
          onCreated={setSelectedId}
        />
        {sync.error && (
          <div className="sync-error-banner">
            <span>{sync.error}</span>
            <button onClick={() => void workspace.collection.utils.syncNow()}>Try again</button>
          </div>
        )}
        <TaskList
          collection={workspace.collection}
          todos={todos}
          view={view}
          selectedId={selectedId}
          isLoading={isLoading}
          onSelect={setSelectedId}
        />
      </section>

      {selected && (
        <TaskInspector
          workspace={workspace}
          todo={selected}
          onClose={() => setSelectedId(null)}
          onDeleted={() => setSelectedId(null)}
        />
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
