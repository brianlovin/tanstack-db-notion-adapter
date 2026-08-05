import type { TodoSchemaRow } from "./todo-schema.generated";

const monthYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
const longDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export type Todo = TodoSchemaRow;
export type TodoView = "inbox" | "today" | "upcoming" | "anytime" | "someday" | "logbook" | "all";

export const views: ReadonlyArray<{
  id: TodoView;
  label: string;
  travelKey: string;
}> = [
  { id: "inbox", label: "Inbox", travelKey: "I" },
  { id: "today", label: "Today", travelKey: "T" },
  { id: "upcoming", label: "Upcoming", travelKey: "U" },
  { id: "anytime", label: "Anytime", travelKey: "A" },
  { id: "someday", label: "Someday", travelKey: "S" },
  { id: "logbook", label: "Logbook", travelKey: "L" },
  { id: "all", label: "All tasks", travelKey: "E" },
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

function effectiveList(todo: Todo): "Inbox" | "Anytime" | "Someday" {
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

function sortTasks(todos: ReadonlyArray<Todo>, view: TodoView): Array<Todo> {
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

export function selectionRange(
  orderedIds: ReadonlyArray<string>,
  anchorId: string,
  focusId: string,
): Set<string> {
  const anchor = orderedIds.indexOf(anchorId);
  const focus = orderedIds.indexOf(focusId);
  if (anchor === -1 || focus === -1) return new Set([focusId]);
  const start = Math.min(anchor, focus);
  const end = Math.max(anchor, focus);
  return new Set(orderedIds.slice(start, end + 1));
}

export interface QuickTaskDraft {
  title: string;
  list: "Inbox" | "Anytime" | "Someday";
  scheduledFor: string | null;
  priority: "Low" | "Medium" | "High";
}

function draftDefaultsForView(view: TodoView, now = new Date()): Omit<QuickTaskDraft, "title"> {
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

function nextPosition(todos: ReadonlyArray<Todo>): number {
  return todos.reduce((maximum, todo) => Math.max(maximum, todo.position ?? 0), 0) + 1_000;
}

function byPosition(left: Todo, right: Todo): number {
  const difference = (left.position ?? 0) - (right.position ?? 0);
  return difference || left.createdAt.localeCompare(right.createdAt);
}

export function positionAfter(todos: ReadonlyArray<Todo>, afterId: string | null): number {
  const ordered = [...todos].sort(byPosition);
  if (ordered.length === 0) return 1_000;
  if (!afterId) return (ordered[0]?.position ?? 0) - 1_000;

  const index = ordered.findIndex((todo) => todo.id === afterId);
  if (index === -1) return nextPosition(todos);
  const current = ordered[index]?.position ?? 0;
  const next = ordered[index + 1]?.position;
  return next == null ? current + 1_000 : current + (next - current) / 2;
}

export function positionForMove(
  todos: ReadonlyArray<Todo>,
  id: string,
  direction: -1 | 1,
): number | null {
  const ordered = [...todos].sort(byPosition);
  const index = ordered.findIndex((todo) => todo.id === id);
  const destination = index + direction;
  if (index === -1 || destination < 0 || destination >= ordered.length) return null;

  if (direction === -1) {
    const before = ordered[destination - 1]?.position;
    const neighbor = ordered[destination]?.position ?? 0;
    return before == null ? neighbor - 1_000 : before + (neighbor - before) / 2;
  }

  const neighbor = ordered[destination]?.position ?? 0;
  const after = ordered[destination + 1]?.position;
  return after == null ? neighbor + 1_000 : neighbor + (after - neighbor) / 2;
}

export function positionsForBlockMove(
  todos: ReadonlyArray<Todo>,
  selectedIds: ReadonlySet<string>,
  direction: -1 | 1,
): Map<string, number> {
  const ordered = [...todos].sort(byPosition);
  const block = ordered.filter((todo) => selectedIds.has(todo.id));
  if (block.length === 0) return new Map();

  const first = ordered.findIndex((todo) => todo.id === block[0]?.id);
  const last = ordered.findIndex((todo) => todo.id === block.at(-1)?.id);
  const boundary = direction === -1 ? first - 1 : last + 1;
  if (boundary < 0 || boundary >= ordered.length) return new Map();

  const lower =
    direction === -1 ? ordered[first - 2]?.position : (ordered[last + 1]?.position ?? 0);
  const upper =
    direction === -1 ? (ordered[first - 1]?.position ?? 0) : ordered[last + 2]?.position;
  const result = new Map<string, number>();

  if (lower == null) {
    const firstPosition = (upper ?? 0) - block.length * 1_000;
    block.forEach((todo, index) => result.set(todo.id, firstPosition + index * 1_000));
    return result;
  }
  if (upper == null) {
    block.forEach((todo, index) => result.set(todo.id, lower + (index + 1) * 1_000));
    return result;
  }

  const step = (upper - lower) / (block.length + 1);
  block.forEach((todo, index) => result.set(todo.id, lower + step * (index + 1)));
  return result;
}

export function groupLabel(todo: Todo, view: TodoView, today = localDate()): string {
  if (view === "today") {
    const scheduled = dateOnly(todo.scheduledFor);
    return scheduled && scheduled < today ? "Overdue" : "Today";
  }
  if (view === "upcoming") return formatLongDate(todo.scheduledFor);
  if (view === "logbook") {
    const date = new Date(todo.completedAt ?? todo.updatedAt);
    return monthYearFormatter.format(date);
  }
  return "Tasks";
}

function formatLongDate(value: string | null): string {
  if (!value) return "No date";
  return longDateFormatter.format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

export function formatShortDate(value: string | null): string {
  if (!value) return "";
  return shortDateFormatter.format(new Date(`${value.slice(0, 10)}T12:00:00`));
}
