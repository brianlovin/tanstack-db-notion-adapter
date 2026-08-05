import type { TodoView } from "./domain";

export type KeyboardCommand =
  | { type: "begin-travel" }
  | { type: "close" }
  | { type: "complete" }
  | { type: "create"; belowSelection: boolean }
  | { type: "focus-deadline" }
  | { type: "focus-when" }
  | { type: "move"; direction: -1 | 1 }
  | { type: "open" }
  | { type: "search"; query?: string }
  | { type: "show-shortcuts" };

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function keyboardCommand(event: KeyboardEvent): KeyboardCommand | null {
  const primary = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const editingText = isTextEntryTarget(event.target);

  if (event.key === "Escape") return { type: "close" };
  if (primary && event.key === "Enter") return { type: "close" };
  if (editingText) return null;

  if (event.altKey && event.key === "ArrowUp") return { type: "move", direction: -1 };
  if (event.altKey && event.key === "ArrowDown") return { type: "move", direction: 1 };
  if (!primary && !event.altKey && event.key === "Enter") {
    return event.shiftKey ? { type: "complete" } : { type: "open" };
  }
  if (!primary && !event.altKey && event.key === " ") {
    return { type: "create", belowSelection: true };
  }
  if (!primary && !event.altKey && event.shiftKey && key === "s") {
    return { type: "focus-when" };
  }
  if (!primary && !event.altKey && event.shiftKey && key === "d") {
    return { type: "focus-deadline" };
  }
  if (!primary && !event.altKey && event.key === "/") return { type: "search" };
  if (!primary && !event.altKey && event.key === "?") return { type: "show-shortcuts" };
  if (!primary && !event.altKey && !event.shiftKey && key === "g") {
    return { type: "begin-travel" };
  }
  if (!primary && !event.altKey && event.key.length === 1 && event.key !== " ") {
    return { type: "search", query: event.key };
  }
  return null;
}

export function viewFromTravelKey(key: string): TodoView | null {
  const destinations: Partial<Record<string, TodoView>> = {
    a: "anytime",
    e: "all",
    i: "inbox",
    l: "logbook",
    s: "someday",
    t: "today",
    u: "upcoming",
  };
  return destinations[key.toLocaleLowerCase()] ?? null;
}
