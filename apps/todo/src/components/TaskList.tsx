import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarClock, Check, Flag, Inbox, Sparkles } from "lucide-react";
import type { TodoWorkspace } from "../collection";
import {
  dateOnly,
  formatShortDate,
  groupLabel,
  localDate,
  positionAfter,
  type Todo,
  type TodoView,
} from "../domain";
import { QuickEntry } from "./QuickEntry";
import { TaskInspector } from "./TaskInspector";

type ListItem =
  | { type: "composer"; key: string }
  | { type: "heading"; key: string; label: string }
  | { type: "task"; key: string; todo: Todo };

interface TaskListProps {
  workspace: TodoWorkspace;
  todos: ReadonlyArray<Todo>;
  view: TodoView;
  selectedIds: ReadonlySet<string>;
  completingIds: ReadonlySet<string>;
  editingId: string | null;
  closingEditorId: string | null;
  editingFocus: "deadline" | "title" | "when";
  composer: { open: boolean; afterId: string | null };
  isLoading: boolean;
  onSelect: (id: string) => void;
  onExtendSelection: (id: string) => void;
  onOpen: (id: string) => void;
  onComplete: () => void;
  onToggleComplete: (todo: Todo) => void;
  onCloseEditor: () => void;
  onCreateBelow: (id: string) => void;
  onCreated: (id: string) => void;
  onDismissComposer: () => void;
  quickEntryRef: React.RefObject<HTMLInputElement | null>;
}

function flatten(todos: ReadonlyArray<Todo>, view: TodoView): Array<ListItem> {
  const grouped = view === "upcoming" || view === "logbook";
  if (!grouped) return todos.map((todo) => ({ type: "task", key: todo.id, todo }));
  const result: Array<ListItem> = [];
  let previous = "";
  for (const todo of todos) {
    const label = groupLabel(todo, view);
    if (label !== previous) {
      result.push({ type: "heading", key: `heading:${label}`, label });
      previous = label;
    }
    result.push({ type: "task", key: todo.id, todo });
  }
  return result;
}

function withComposer(
  items: Array<ListItem>,
  composer: { open: boolean; afterId: string | null },
): Array<ListItem> {
  if (!composer.open) return items;
  const result = [...items];
  const selectedIndex = composer.afterId
    ? result.findIndex((item) => item.type === "task" && item.todo.id === composer.afterId)
    : -1;
  const firstTask = result.findIndex((item) => item.type === "task");
  const insertion = selectedIndex >= 0 ? selectedIndex + 1 : Math.max(firstTask, 0);
  result.splice(insertion, 0, { type: "composer", key: "new-task" });
  return result;
}

function dateTone(todo: Todo): string {
  const deadline = dateOnly(todo.deadline);
  if (!deadline) return "";
  if (!todo.completed && deadline < localDate()) return " is-overdue";
  return "";
}

export function TaskList({
  workspace,
  todos,
  view,
  selectedIds,
  completingIds,
  editingId,
  closingEditorId,
  editingFocus,
  composer,
  isLoading,
  onSelect,
  onExtendSelection,
  onOpen,
  onComplete,
  onToggleComplete,
  onCloseEditor,
  onCreateBelow,
  onCreated,
  onDismissComposer,
  quickEntryRef,
}: TaskListProps) {
  const container = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () => withComposer(flatten(todos, view), composer),
    [composer, todos, view],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => container.current,
    getItemKey: (index) => items[index]?.key ?? index,
    estimateSize: (index) => {
      const item = items[index];
      if (item?.type === "heading") return 52;
      if (item?.type === "composer") return 210;
      if (item?.type === "task" && item.todo.id === editingId) return 367;
      return 46;
    },
    overscan: 12,
  });

  const selectNeighbor = (index: number, direction: -1 | 1, extend = false) => {
    let next = index + direction;
    while (next >= 0 && next < items.length) {
      const item = items[next];
      if (item?.type === "task") {
        if (extend) onExtendSelection(item.todo.id);
        else onSelect(item.todo.id);
        virtualizer.scrollToIndex(next, { align: "auto" });
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(`[data-task-id="${CSS.escape(item.todo.id)}"]`)
            ?.focus();
        });
        return;
      }
      next += direction;
    }
  };

  if (isLoading && todos.length === 0 && !composer.open) {
    return (
      <div className="list-state">
        <span className="loading-ring" />
        Loading your local workspace…
      </div>
    );
  }
  if (todos.length === 0 && !composer.open) {
    return (
      <div className="empty-state">
        <span>
          <Sparkles size={22} />
        </span>
        <h2>{view === "logbook" ? "Nothing logged yet" : "Nothing here"}</h2>
        <p>
          {view === "inbox"
            ? "Press Space to add a to-do."
            : "Press Space whenever something belongs here."}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={container}
      className={`task-scroll view-${view}`}
      role="region"
      aria-label={`${view} tasks`}
    >
      <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]!;
          if (item.type === "heading") {
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="task-group-heading"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {item.label}
              </div>
            );
          }
          if (item.type === "composer") {
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="virtual-row composer-row"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <QuickEntry
                  ref={quickEntryRef}
                  collection={workspace.collection}
                  view={view}
                  position={positionAfter(todos, composer.afterId)}
                  onCreated={onCreated}
                  onDismiss={onDismissComposer}
                />
              </div>
            );
          }

          const todo = item.todo;
          const editing = editingId === todo.id;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className={editing ? "virtual-row editor-row" : "virtual-row"}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {editing ? (
                <TaskInspector
                  workspace={workspace}
                  todo={todo}
                  focusField={editingFocus}
                  completing={completingIds.has(todo.id)}
                  closing={closingEditorId === todo.id}
                  onToggleComplete={() => onToggleComplete(todo)}
                  onDeleted={onCloseEditor}
                />
              ) : (
                <div
                  className={`task-row${selectedIds.has(todo.id) ? " is-selected" : ""}${completingIds.has(todo.id) ? " is-completing" : ""}`}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={todo.completed || completingIds.has(todo.id)}
                    className={
                      todo.completed || completingIds.has(todo.id)
                        ? "task-check is-checked"
                        : "task-check"
                    }
                    disabled={completingIds.has(todo.id)}
                    onClick={() => onToggleComplete(todo)}
                    aria-label={todo.completed ? `Restore ${todo.title}` : `Complete ${todo.title}`}
                  >
                    {(todo.completed || completingIds.has(todo.id)) && (
                      <Check size={13} strokeWidth={3} />
                    )}
                  </button>
                  <button
                    type="button"
                    data-task-id={todo.id}
                    className="task-open"
                    aria-pressed={selectedIds.has(todo.id)}
                    onClick={(event) => {
                      if (event.shiftKey) onExtendSelection(todo.id);
                      else onSelect(todo.id);
                    }}
                    onDoubleClick={() => onOpen(todo.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        selectNeighbor(virtualRow.index, 1, event.shiftKey);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        selectNeighbor(virtualRow.index, -1, event.shiftKey);
                      } else if (event.key === " ") {
                        event.preventDefault();
                        onCreateBelow(todo.id);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        if (event.shiftKey) onComplete();
                        else onOpen(todo.id);
                      }
                    }}
                  >
                    <span className="task-copy">
                      <span className="task-title">{todo.title}</span>
                      {(todo.scheduledFor || todo.deadline || !todo.notionPageId) && (
                        <span className="task-metadata">
                          {todo.scheduledFor && view !== "today" && (
                            <span>
                              <CalendarClock size={12} />
                              {formatShortDate(todo.scheduledFor)}
                            </span>
                          )}
                          {todo.deadline && (
                            <span className={`deadline${dateTone(todo)}`}>
                              Due {formatShortDate(todo.deadline)}
                            </span>
                          )}
                          {!todo.notionPageId && (
                            <span>
                              <Inbox size={12} />
                              Local
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                  {todo.priority === "High" && (
                    <Flag
                      className="priority-flag"
                      size={14}
                      fill="currentColor"
                      aria-label="High priority"
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
