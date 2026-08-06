import { useEffect, useRef, useState } from "react";
import {
  Calendar,
  Check,
  CircleAlert,
  ExternalLink,
  Flag,
  ListTodo,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { TodoWorkspace } from "../collection";
import { localDate, tomorrowDate, type Todo } from "../domain";
import { useTaskContent } from "../hooks";

interface TaskInspectorProps {
  workspace: TodoWorkspace;
  todo: Todo;
  focusField?: "deadline" | "title" | "when";
  completing: boolean;
  closing: boolean;
  onToggleComplete: () => void;
  onDeleted: () => void;
}

const editorDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function contentLabel(status: string | undefined): string {
  switch (status) {
    case "saved-local":
      return "Saved locally";
    case "syncing":
      return "Saving to Notion…";
    case "synced":
      return "Saved to Notion";
    case "offline":
      return "Offline — saved locally";
    case "conflict":
      return "Notes changed in Notion";
    case "error":
      return "Notes need attention";
    case "loading":
      return "Loading notes…";
    default:
      return "Ready";
  }
}

function formatEditorDate(value: string): string {
  const date = value.slice(0, 10);
  if (date === localDate()) return "Today";
  if (date === tomorrowDate()) return "Tomorrow";
  return editorDateFormatter.format(new Date(`${date}T12:00:00`));
}

export function TaskInspector({
  workspace,
  todo,
  focusField = "title",
  completing,
  closing,
  onToggleComplete,
  onDeleted,
}: TaskInspectorProps) {
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [contentLoadAttempt, setContentLoadAttempt] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const whenInput = useRef<HTMLInputElement>(null);
  const deadlineInput = useRef<HTMLInputElement>(null);
  const content = useTaskContent(workspace, todo.id);

  useEffect(() => setTitle(todo.title), [todo.id, todo.title]);
  useEffect(() => {
    let target: HTMLInputElement | HTMLTextAreaElement | null;
    switch (focusField) {
      case "when":
        target = whenInput.current;
        break;
      case "deadline":
        target = deadlineInput.current;
        break;
      case "title":
        target = titleInput.current;
        break;
    }
    requestAnimationFrame(() => target?.focus());
  }, [focusField, todo.id]);
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      try {
        await workspace.content.ready();
        if (!workspace.content.get(todo.id)) {
          await workspace.content.createDraft(todo.id);
        }
        if (todo.notionPageId) {
          await workspace.content.attachPage(todo.id, todo.notionPageId);
        }
        if (active) setNotesError(null);
      } catch (error) {
        if (active)
          setNotesError(error instanceof Error ? error.message : "Notes could not be loaded.");
      }
    };
    void prepare();
    return () => {
      active = false;
    };
  }, [todo.id, todo.notionPageId, workspace, contentLoadAttempt]);

  useEffect(() => {
    if (content) setNotes(content.markdown);
  }, [content?.key, content?.markdown, content?.revision]);

  const saveTitle = () => {
    const next = title.trim();
    if (!next) {
      setTitle(todo.title);
      return;
    }
    if (next === todo.title) return;
    workspace.collection.update(todo.id, (draft) => {
      draft.title = next;
    });
  };
  const updateDate = (field: "scheduledFor" | "deadline", value: string | null) => {
    workspace.collection.update(todo.id, (draft) => {
      draft[field] = value;
    });
  };
  const updateNotes = (value: string) => {
    setNotes(value);
    setNotesError(null);
    void workspace.content.update(todo.id, value).catch((error: unknown) => {
      setNotesError(error instanceof Error ? error.message : "Notes could not be saved.");
    });
  };

  return (
    <article
      className={closing ? "task-editor is-closing" : "task-editor"}
      data-task-editor={todo.id}
      aria-label={`Details for ${todo.title}`}
    >
      <div className="task-editor-body">
        <div className="title-editor">
          <button
            className={todo.completed || completing ? "large-check is-checked" : "large-check"}
            onClick={onToggleComplete}
            disabled={completing}
            aria-label={todo.completed ? "Mark incomplete" : "Complete task"}
          >
            {(todo.completed || completing) && <Check size={15} strokeWidth={3} />}
          </button>
          <textarea
            ref={titleInput}
            data-task-title
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                saveTitle();
                event.currentTarget.blur();
              }
            }}
            rows={1}
            aria-label="Task title"
          />
        </div>

        <section className="notes-section">
          {content?.truncated || content?.unknownBlockIds.length ? (
            <div className="content-warning">
              <CircleAlert size={17} />
              <p>
                This Notion page contains blocks the markdown editor cannot safely round-trip. Notes
                are read-only here.
              </p>
            </div>
          ) : (
            <textarea
              className="notes-editor"
              value={notes}
              onChange={(event) => updateNotes(event.target.value)}
              placeholder="Notes"
              aria-label="Task notes"
            />
          )}
          {(notesError || content?.error) && (
            <div className="field-error">
              <span>{notesError ?? content?.error}</span>
              <button onClick={() => setContentLoadAttempt((attempt) => attempt + 1)}>
                Retry notes
              </button>
            </div>
          )}
          {content?.status === "conflict" && (
            <div className="conflict-actions">
              <button onClick={() => void workspace.content.acceptRemote(todo.id)}>
                Use Notion version
              </button>
              <button
                onClick={() =>
                  void workspace.content.overwriteRemote(todo.id, { acceptDataLoss: true })
                }
              >
                Keep this version
              </button>
            </div>
          )}
        </section>

        <footer className="task-editor-controls" aria-label="Task properties">
          <label className={todo.scheduledFor ? "schedule-control has-value" : "schedule-control"}>
            <Calendar size={15} />
            <span>{todo.scheduledFor ? formatEditorDate(todo.scheduledFor) : "When"}</span>
            <input
              ref={whenInput}
              data-task-when
              aria-label="When"
              type="date"
              value={todo.scheduledFor?.slice(0, 10) ?? ""}
              onChange={(event) => updateDate("scheduledFor", event.target.value || null)}
            />
          </label>
          <div className="editor-property-actions">
            <label className="editor-icon-property" title={`List: ${todo.list ?? "Inbox"}`}>
              <ListTodo />
              <span className="sr-only">List</span>
              <select
                aria-label="List"
                value={todo.list ?? "Inbox"}
                onChange={(event) =>
                  workspace.collection.update(todo.id, (draft) => {
                    draft.list = event.target.value as Todo["list"];
                    if (draft.list === "Someday") draft.scheduledFor = null;
                  })
                }
              >
                <option>Inbox</option>
                <option>Anytime</option>
                <option>Someday</option>
              </select>
            </label>
            <label
              className={todo.deadline ? "editor-icon-property has-value" : "editor-icon-property"}
              title={
                todo.deadline ? `Deadline: ${formatEditorDate(todo.deadline)}` : "Set deadline"
              }
            >
              <Flag />
              <span className="sr-only">Deadline</span>
              <input
                ref={deadlineInput}
                data-task-deadline
                aria-label="Deadline"
                type="date"
                value={todo.deadline?.slice(0, 10) ?? ""}
                onChange={(event) => updateDate("deadline", event.target.value || null)}
              />
            </label>
            <details className="editor-more">
              <summary aria-label="More task actions" title="More task actions">
                <MoreHorizontal />
              </summary>
              <div className="editor-more-menu">
                <label className="editor-more-select">
                  <Flag />
                  <span>Priority</span>
                  <select
                    aria-label="Priority"
                    value={todo.priority ?? "Medium"}
                    onChange={(event) =>
                      workspace.collection.update(todo.id, (draft) => {
                        draft.priority = event.target.value as Todo["priority"];
                      })
                    }
                  >
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                  </select>
                </label>
                {todo.notionUrl && (
                  <a href={todo.notionUrl} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open in Notion
                  </a>
                )}
                {content?.pending && (
                  <button onClick={() => void workspace.content.flush(todo.id)}>
                    <RefreshCw /> Save now
                  </button>
                )}
                {!confirmDelete ? (
                  <button className="danger-text" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete
                  </button>
                ) : (
                  <>
                    <button onClick={() => setConfirmDelete(false)}>Cancel</button>
                    <button
                      className="danger-text"
                      onClick={() => {
                        workspace.collection.delete(todo.id);
                        onDeleted();
                      }}
                    >
                      <Trash2 /> Confirm delete
                    </button>
                  </>
                )}
              </div>
            </details>
          </div>
          <small
            className={`sr-only content-status status-${content?.status ?? "idle"}`}
            aria-live="polite"
          >
            {contentLabel(content?.status)}
          </small>
        </footer>
      </div>
    </article>
  );
}
