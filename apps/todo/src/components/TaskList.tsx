import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarClock, Check, Flag, Inbox, Sparkles } from "lucide-react";
import type { TodoCollection } from "../collection";
import {
  dateOnly,
  formatShortDate,
  groupLabel,
  localDate,
  type Todo,
  type TodoView,
} from "../domain";

type ListItem =
  | { type: "heading"; key: string; label: string }
  | { type: "task"; key: string; todo: Todo };

interface TaskListProps {
  collection: TodoCollection;
  todos: ReadonlyArray<Todo>;
  view: TodoView;
  selectedId: string | null;
  isLoading: boolean;
  onSelect: (id: string) => void;
}

function flatten(todos: ReadonlyArray<Todo>, view: TodoView): Array<ListItem> {
  const grouped = view === "today" || view === "upcoming" || view === "logbook";
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

function dateTone(todo: Todo): string {
  const deadline = dateOnly(todo.deadline);
  if (!deadline) return "";
  if (!todo.completed && deadline < localDate()) return " is-overdue";
  return "";
}

export function TaskList({
  collection,
  todos,
  view,
  selectedId,
  isLoading,
  onSelect,
}: TaskListProps) {
  const container = useRef<HTMLDivElement>(null);
  const items = useMemo(() => flatten(todos, view), [todos, view]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => container.current,
    estimateSize: (index) => (items[index]?.type === "heading" ? 46 : 58),
    overscan: 12,
  });

  const selectNeighbor = (index: number, direction: -1 | 1) => {
    let next = index + direction;
    while (next >= 0 && next < items.length) {
      const item = items[next];
      if (item?.type === "task") {
        onSelect(item.todo.id);
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

  if (isLoading && todos.length === 0) {
    return (
      <div className="list-state">
        <span className="loading-ring" />
        Loading your local workspace…
      </div>
    );
  }
  if (todos.length === 0) {
    return (
      <div className="empty-state">
        <span>
          <Sparkles size={24} />
        </span>
        <h2>{view === "logbook" ? "Nothing logged yet" : "A clear list"}</h2>
        <p>
          {view === "inbox"
            ? "Capture something above, then decide when it belongs."
            : "There are no tasks in this view."}
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
          const todo = item.todo;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className="virtual-row"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <button
                data-task-id={todo.id}
                className={selectedId === todo.id ? "task-row is-selected" : "task-row"}
                onClick={() => onSelect(todo.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    selectNeighbor(virtualRow.index, 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    selectNeighbor(virtualRow.index, -1);
                  }
                }}
              >
                <span
                  role="checkbox"
                  aria-checked={todo.completed}
                  tabIndex={0}
                  className={todo.completed ? "task-check is-checked" : "task-check"}
                  onClick={(event) => {
                    event.stopPropagation();
                    collection.update(todo.id, (draft) => {
                      draft.completed = !todo.completed;
                      draft.completedAt = todo.completed ? null : new Date().toISOString();
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== " " && event.key !== "Enter") return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                  aria-label={todo.completed ? `Restore ${todo.title}` : `Complete ${todo.title}`}
                >
                  {todo.completed && <Check size={14} strokeWidth={3} />}
                </span>
                <span className="task-copy">
                  <span className="task-title">{todo.title}</span>
                  <span className="task-metadata">
                    {todo.scheduledFor && (
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
                        Saved locally
                      </span>
                    )}
                  </span>
                </span>
                {todo.priority === "High" && (
                  <Flag
                    className="priority-flag"
                    size={15}
                    fill="currentColor"
                    aria-label="High priority"
                  />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
