import type { TodoSchemaRow } from "./todo-schema.generated";

export type Todo = TodoSchemaRow;
export type TodoView = "inbox" | "today" | "upcoming" | "anytime" | "someday" | "logbook" | "all";

export const views: ReadonlyArray<{
  id: TodoView;
  label: string;
  shortcut?: string;
}> = [
  { id: "inbox", label: "Inbox", shortcut: "2" },
  { id: "today", label: "Today", shortcut: "1" },
  { id: "upcoming", label: "Upcoming", shortcut: "3" },
  { id: "anytime", label: "Anytime", shortcut: "4" },
  { id: "someday", label: "Someday", shortcut: "5" },
  { id: "logbook", label: "Logbook" },
  { id: "all", label: "All tasks" },
];

export function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function tomorrowDate(now = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return localDate(tomorrow);
}

export function dateOnly(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

export function effectiveList(todo: Todo): "Inbox" | "Anytime" | "Someday" {
  return todo.list ?? "Inbox";
}

export function taskMatchesView(todo: Todo, view: TodoView, today = localDate()): boolean {
  if (view === "logbook") return todo.completed;
  if (todo.completed) return false;
  const scheduled = dateOnly(todo.scheduledFor);
  switch (view) {
    case "inbox":
      return effectiveList(todo) === "Inbox";
    case "today":
      return scheduled !== null && scheduled <= today;
    case "upcoming":
      return scheduled !== null && scheduled > today;
    case "anytime":
      return effectiveList(todo) === "Anytime" && scheduled === null;
    case "someday":
      return effectiveList(todo) === "Someday";
    case "all":
      return true;
  }
}

export function sortTasks(todos: ReadonlyArray<Todo>, view: TodoView): Array<Todo> {
  return [...todos].sort((left, right) => {
    if (view === "logbook") {
      return (right.completedAt ?? right.updatedAt).localeCompare(
        left.completedAt ?? left.updatedAt,
      );
    }
    const leftDate = dateOnly(left.scheduledFor) ?? "9999-12-31";
    const rightDate = dateOnly(right.scheduledFor) ?? "9999-12-31";
    if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    const positionDifference = (left.position ?? 0) - (right.position ?? 0);
    if (positionDifference !== 0) return positionDifference;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function visibleTasks(
  todos: ReadonlyArray<Todo>,
  view: TodoView,
  search: string,
  today = localDate(),
): Array<Todo> {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return sortTasks(
    todos.filter(
      (todo) =>
        taskMatchesView(todo, view, today) &&
        (!normalizedSearch || todo.title.toLocaleLowerCase().includes(normalizedSearch)),
    ),
    view,
  );
}

export function taskCounts(
  todos: ReadonlyArray<Todo>,
  today = localDate(),
): Record<TodoView, number> {
  return Object.fromEntries(
    views.map((view) => [
      view.id,
      todos.filter((todo) => taskMatchesView(todo, view.id, today)).length,
    ]),
  ) as Record<TodoView, number>;
}

export interface QuickTaskDraft {
  title: string;
  list: "Inbox" | "Anytime" | "Someday";
  scheduledFor: string | null;
  priority: "Low" | "Medium" | "High";
}

export function draftDefaultsForView(
  view: TodoView,
  now = new Date(),
): Omit<QuickTaskDraft, "title"> {
  switch (view) {
    case "today":
      return { list: "Anytime", scheduledFor: localDate(now), priority: "Medium" };
    case "upcoming":
      return {
        list: "Anytime",
        scheduledFor: tomorrowDate(now),
        priority: "Medium",
      };
    case "anytime":
      return { list: "Anytime", scheduledFor: null, priority: "Medium" };
    case "someday":
      return { list: "Someday", scheduledFor: null, priority: "Medium" };
    default:
      return { list: "Inbox", scheduledFor: null, priority: "Medium" };
  }
}

export function parseQuickTask(
  input: string,
  view: TodoView,
  now = new Date(),
): QuickTaskDraft | null {
  const defaults = draftDefaultsForView(view, now);
  let title = input.trim();
  if (!title) return null;

  let list = defaults.list;
  let scheduledFor = defaults.scheduledFor;
  let priority = defaults.priority;
  const directives = [
    [/@today\b/gi, () => (scheduledFor = localDate(now))],
    [/@tomorrow\b/gi, () => (scheduledFor = tomorrowDate(now))],
    [/@inbox\b/gi, () => (list = "Inbox")],
    [/@anytime\b/gi, () => (list = "Anytime")],
    [/@someday\b/gi, () => (list = "Someday")],
    [/!high\b/gi, () => (priority = "High")],
    [/!medium\b/gi, () => (priority = "Medium")],
    [/!low\b/gi, () => (priority = "Low")],
  ] as const;
  for (const [pattern, apply] of directives) {
    if (pattern.test(title)) {
      apply();
      title = title.replace(pattern, " ");
    }
  }
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (list === "Someday") scheduledFor = null;
  return { title, list, scheduledFor, priority };
}

export function nextPosition(todos: ReadonlyArray<Todo>): number {
  return todos.reduce((maximum, todo) => Math.max(maximum, todo.position ?? 0), 0) + 1_000;
}

export function groupLabel(todo: Todo, view: TodoView, today = localDate()): string {
  if (view === "today") {
    const scheduled = dateOnly(todo.scheduledFor);
    return scheduled && scheduled < today ? "Overdue" : "Today";
  }
  if (view === "upcoming") return formatLongDate(todo.scheduledFor);
  if (view === "logbook") {
    const date = new Date(todo.completedAt ?? todo.updatedAt);
    return new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric",
    }).format(date);
  }
  return "Tasks";
}

export function formatLongDate(value: string | null): string {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

export function formatShortDate(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}
