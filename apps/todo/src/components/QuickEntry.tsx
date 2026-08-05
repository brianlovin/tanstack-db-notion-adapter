import { forwardRef, useEffect, useState, type FormEvent } from "react";
import { ArrowUp, Check, X } from "lucide-react";
import type { TodoCollection } from "../collection";
import { parseQuickTask, type TodoView } from "../domain";
import type { TodoSchemaInput } from "../todo-schema.generated";

interface QuickEntryProps {
  collection: TodoCollection;
  view: TodoView;
  position: number;
  onCreated: (id: string) => void;
  onDismiss: () => void;
}

export const QuickEntry = forwardRef<HTMLInputElement, QuickEntryProps>(function QuickEntry(
  { collection, view, position, onCreated, onDismiss },
  ref,
) {
  const [value, setValue] = useState("");

  useEffect(() => {
    requestAnimationFrame(() => {
      if (typeof ref === "function") return;
      ref?.current?.focus();
    });
  }, [ref]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const draft = parseQuickTask(value, view);
    if (!draft) return;
    const id = crypto.randomUUID();
    const input: TodoSchemaInput = {
      ...draft,
      id,
      position,
      completed: false,
      completedAt: null,
      deadline: null,
    };
    collection.insert(input);
    setValue("");
    onCreated(id);
  };

  return (
    <form className="quick-entry" onSubmit={submit}>
      <span className="quick-check" aria-hidden="true">
        <Check size={13} />
      </span>
      <label className="sr-only" htmlFor="quick-task-title">
        Create a task
      </label>
      <input
        ref={ref}
        id="quick-task-title"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
          }
        }}
        placeholder="New to-do"
        autoComplete="off"
      />
      {value && (
        <button className="quick-submit" type="submit" aria-label="Create task">
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      )}
      <button className="quick-dismiss" type="button" onClick={onDismiss} aria-label="Cancel">
        <X size={15} />
      </button>
      <p className="quick-notes" aria-hidden="true">
        Notes
      </p>
      <p className="quick-destination">
        <span>{view === "all" || view === "logbook" ? "Inbox" : view}</span>
        <small>@today · @someday · !high</small>
      </p>
    </form>
  );
});
