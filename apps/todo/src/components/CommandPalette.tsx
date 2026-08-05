import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ListTodo, Search } from "lucide-react";
import { views, type Todo, type TodoView } from "../domain";

type PaletteResult =
  | { id: string; kind: "task"; label: string; todo: Todo }
  | { id: string; kind: "view"; label: string; view: TodoView; travelKey: string };

interface CommandPaletteProps {
  query: string;
  todos: ReadonlyArray<Todo>;
  onQuery: (query: string) => void;
  onClose: () => void;
  onTask: (todo: Todo) => void;
  onView: (view: TodoView) => void;
}

function ResultIcon({ result }: { result: PaletteResult }) {
  if (result.kind === "view") return <ListTodo size={15} />;
  if (result.todo.completed) return <CheckCircle2 size={15} />;
  return <span className="mini-check" />;
}

export default function CommandPalette({
  query,
  todos,
  onQuery,
  onClose,
  onTask,
  onView,
}: CommandPaletteProps) {
  const input = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo<Array<PaletteResult>>(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const viewResults: Array<PaletteResult> = [];
    for (const view of views) {
      if (!normalized || view.label.toLocaleLowerCase().includes(normalized)) {
        viewResults.push({
          id: `view:${view.id}`,
          kind: "view" as const,
          label: view.label,
          view: view.id,
          travelKey: view.travelKey,
        });
      }
    }
    const taskResults: Array<PaletteResult> = [];
    if (normalized) {
      for (const todo of todos) {
        if (!todo.title.toLocaleLowerCase().includes(normalized)) continue;
        taskResults.push({
          id: `task:${todo.id}`,
          kind: "task" as const,
          label: todo.title,
          todo,
        });
        if (taskResults.length === 12) break;
      }
    }
    return [...viewResults, ...taskResults];
  }, [query, todos]);

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);

  const choose = (result: PaletteResult | undefined) => {
    if (!result) return;
    if (result.kind === "view") onView(result.view);
    else onTask(result.todo);
    onClose();
  };

  return (
    <div className="palette-layer" role="presentation">
      <button className="palette-scrim" type="button" onClick={onClose} aria-label="Close search" />
      <dialog open className="command-palette" aria-label="Search">
        <label className="palette-input">
          <Search size={18} />
          <span className="sr-only">Search tasks and lists</span>
          <input
            ref={input}
            data-search-input
            value={query}
            onChange={(event) => {
              setActiveIndex(0);
              onQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(results[activeIndex]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Go to a list or find a to-do…"
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </label>
        <div className="palette-results" role="listbox">
          {results.map((result, index) => (
            <button
              key={result.id}
              type="button"
              className={index === activeIndex ? "palette-result is-active" : "palette-result"}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(result)}
              role="option"
              aria-selected={index === activeIndex}
            >
              <span className={result.kind === "view" ? "result-icon is-view" : "result-icon"}>
                <ResultIcon result={result} />
              </span>
              <span>{result.label}</span>
              {result.kind === "view" ? <kbd>G {result.travelKey}</kbd> : <ArrowRight size={14} />}
            </button>
          ))}
          {results.length === 0 && (
            <p className="palette-empty">No matching to-dos. Press ⌘N to make one.</p>
          )}
        </div>
        <footer className="palette-footer">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>Start typing anywhere to search</span>
        </footer>
      </dialog>
    </div>
  );
}
