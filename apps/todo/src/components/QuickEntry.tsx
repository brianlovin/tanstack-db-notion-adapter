import { forwardRef, useState, type FormEvent } from "react";
import { ArrowUp, Plus } from "lucide-react";
import type { TodoCollection } from "../collection";
import { nextPosition, parseQuickTask, type Todo, type TodoView } from "../domain";

interface QuickEntryProps {
  collection: TodoCollection;
  todos: ReadonlyArray<Todo>;
  view: TodoView;
  onCreated: (id: string) => void;
}

export const QuickEntry = forwardRef<HTMLInputElement, QuickEntryProps>(function QuickEntry(
  { collection, todos, view, onCreated },
  ref,
) {
  const [value, setValue] = useState("");
  const [hintVisible, setHintVisible] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const draft = parseQuickTask(value, view);
    if (!draft) return;
    const id = crypto.randomUUID();
    collection.insert({
      ...draft,
      id,
      position: nextPosition(todos),
      completed: false,
      completedAt: null,
      deadline: null,
    });
    setValue("");
    setHintVisible(false);
    onCreated(id);
  };

  return (
    <form className="quick-entry" onSubmit={submit}>
      <span className="quick-plus" aria-hidden="true">
        <Plus size={19} />
      </span>
      <label className="sr-only" htmlFor="quick-task">
        Create a task
      </label>
      <input
        ref={ref}
        id="quick-task"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setHintVisible(true)}
        onBlur={() => !value && setHintVisible(false)}
        placeholder="New task"
        autoComplete="off"
      />
      {!value && <kbd>⌘N</kbd>}
      {value && (
        <button type="submit" aria-label="Create task">
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      )}
      {hintVisible && (
        <div className="quick-hints" role="note">
          <span>
            <b>@today</b> schedule
          </span>
          <span>
            <b>@someday</b> file away
          </span>
          <span>
            <b>!high</b> prioritize
          </span>
        </div>
      )}
    </form>
  );
});
