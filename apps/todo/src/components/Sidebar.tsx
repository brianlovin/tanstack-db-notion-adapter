import {
  Archive,
  CalendarDays,
  CheckCircle2,
  Inbox,
  Layers3,
  ListTodo,
  Search,
  Sun,
} from "lucide-react";
import type { NotionSyncState } from "tanstack-db-notion-adapter";
import { views, type TodoView } from "../domain";

const icons = {
  inbox: Inbox,
  today: Sun,
  upcoming: CalendarDays,
  anytime: Layers3,
  someday: Archive,
  logbook: CheckCircle2,
  all: ListTodo,
} as const;

interface SidebarProps {
  view: TodoView;
  counts: Record<TodoView, number>;
  search: string;
  sync: NotionSyncState;
  developmentBypass: boolean;
  onView: (view: TodoView) => void;
  onSearch: (search: string) => void;
  onSync: () => void;
  onLogout: () => void;
}

function syncLabel(sync: NotionSyncState): string {
  if (sync.status === "offline") return "Offline — edits are safe";
  if (sync.status === "error") return "Sync needs attention";
  if (sync.status === "syncing" || sync.status === "hydrating") return "Syncing with Notion";
  if (sync.pendingMutations) return `${sync.pendingMutations} change pending`;
  return "Notion is up to date";
}

export function Sidebar({
  view,
  counts,
  search,
  sync,
  developmentBypass,
  onView,
  onSearch,
  onSync,
  onLogout,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="Daylight">
        <span className="brand-mark">
          <Sun size={18} strokeWidth={2.4} />
        </span>
        <span>Daylight</span>
      </div>

      <label className="search-field">
        <Search size={15} aria-hidden="true" />
        <span className="sr-only">Search tasks</span>
        <input
          data-search-input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search"
        />
        <kbd>⌘K</kbd>
      </label>

      <nav className="view-navigation" aria-label="Task lists">
        {views.map((item, index) => {
          const Icon = icons[item.id];
          const separate = index === 3 || index === 5;
          return (
            <div key={item.id} className={separate ? "nav-separator" : undefined}>
              <button
                className={view === item.id ? "nav-item is-active" : "nav-item"}
                onClick={() => onView(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon size={17} strokeWidth={2} aria-hidden="true" />
                <span>{item.label}</span>
                <span className="nav-count">{counts[item.id]}</span>
              </button>
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button className={`sync-card status-${sync.status}`} onClick={onSync}>
          <span className="sync-orbit" aria-hidden="true">
            <span />
          </span>
          <span>
            <strong>{syncLabel(sync)}</strong>
            <small>{sync.storage} cache · click to refresh</small>
          </span>
        </button>
        {developmentBypass ? (
          <span className="dev-badge">Local auth bypass</span>
        ) : (
          <button className="text-button" onClick={onLogout}>
            Lock workspace
          </button>
        )}
      </div>
    </aside>
  );
}
