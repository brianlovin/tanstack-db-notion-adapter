import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ListTodo, Search } from "lucide-react";
import { views, type Todo, type TodoView } from "../domain";

type PaletteResult =
  | { id: string; kind: "task"; label: string; todo: Todo }
  | { id: string; kind: "view"; label: string; view: TodoView; travelKey: string };

interface CommandPaletteProps {
  open: boolean;
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
  open,
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
    const viewResults = views
      .filter((view) => !normalized || view.label.toLocaleLowerCase().includes(normalized))
      .map((view) => ({
        id: `view:${view.id}`,
        kind: "view" as const,
        label: view.label,
        view: view.id,
        travelKey: view.travelKey,
      }));
    const taskResults = todos
      .filter((todo) => normalized && todo.title.toLocaleLowerCase().includes(normalized))
      .slice(0, 12)
      .map((todo) => ({
        id: `task:${todo.id}`,
        kind: "task" as const,
        label: todo.title,
        todo,
      }));
    return [...viewResults, ...taskResults];
  }, [query, todos]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  useEffect(() => setActiveIndex(0), [query]);

  if (!open) return null;
  const choose = (result: PaletteResult | undefined) => {
    if (!result) return;
    if (result.kind === "view") onView(result.view);
    else onTask(result.todo);
    onClose();
  };

  return (
    <div className="palette-layer" role="presentation">
      <button className="palette-scrim" onClick={onClose} aria-label="Close search" />
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Search">
        <label className="palette-input">
          <Search size={18} />
          <span className="sr-only">Search tasks and lists</span>
          <input
            ref={input}
            data-search-input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
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
      </section>
    </div>
  );
}
