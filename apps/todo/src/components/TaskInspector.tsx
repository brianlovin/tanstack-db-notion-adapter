import { useEffect, useState } from "react";
import {
  Calendar,
  Check,
  ChevronLeft,
  CircleAlert,
  ExternalLink,
  Flag,
  Inbox,
  ListChecks,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { TodoWorkspace } from "../collection";
import { localDate, tomorrowDate, type Todo } from "../domain";
import { useTaskContent } from "../hooks";

interface TaskInspectorProps {
  workspace: TodoWorkspace;
  todo: Todo;
  onClose: () => void;
  onDeleted: () => void;
}

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

export function TaskInspector({ workspace, todo, onClose, onDeleted }: TaskInspectorProps) {
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [contentLoadAttempt, setContentLoadAttempt] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const content = useTaskContent(workspace, todo.id);

  useEffect(() => setTitle(todo.title), [todo.id, todo.title]);
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      try {
        await workspace.content.ready();
        let current = workspace.content.get(todo.id);
        if (!current) {
          await workspace.content.createDraft(todo.id);
          current = workspace.content.get(todo.id);
        }
        if (todo.notionPageId && current?.notionPageId !== todo.notionPageId) {
          await workspace.content.attachPage(todo.id, todo.notionPageId);
        } else if (todo.notionPageId && current && !current.pending) {
          await workspace.content.load(todo.id, todo.notionPageId);
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
    <aside className="inspector" aria-label={`Details for ${todo.title}`}>
      <header className="inspector-header">
        <button
          className="icon-control mobile-back"
          onClick={onClose}
          aria-label="Back to task list"
        >
          <ChevronLeft />
        </button>
        <span className="inspector-kicker">Task</span>
        <div className="inspector-actions">
          {todo.notionUrl && (
            <a
              className="icon-control"
              href={todo.notionUrl}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in Notion"
            >
              <ExternalLink />
            </a>
          )}
          <button className="icon-control" onClick={onClose} aria-label="Close task details">
            <X />
          </button>
        </div>
      </header>

      <div className="inspector-scroll">
        <div className="title-editor">
          <button
            className={todo.completed ? "large-check is-checked" : "large-check"}
            onClick={() =>
              workspace.collection.update(todo.id, (draft) => {
                draft.completed = !todo.completed;
                draft.completedAt = todo.completed ? null : new Date().toISOString();
              })
            }
            aria-label={todo.completed ? "Mark incomplete" : "Complete task"}
          >
            {todo.completed && <Check size={15} strokeWidth={3} />}
          </button>
          <textarea
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                saveTitle();
                event.currentTarget.blur();
              }
            }}
            rows={2}
            aria-label="Task title"
          />
        </div>

        <section className="inspector-section properties-grid" aria-label="Task properties">
          <label>
            <span>
              <Inbox size={15} />
              List
            </span>
            <select
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
          <label>
            <span>
              <Calendar size={15} />
              When
            </span>
            <input
              type="date"
              value={todo.scheduledFor?.slice(0, 10) ?? ""}
              onChange={(event) => updateDate("scheduledFor", event.target.value || null)}
            />
          </label>
          <label>
            <span>
              <CircleAlert size={15} />
              Deadline
            </span>
            <input
              type="date"
              value={todo.deadline?.slice(0, 10) ?? ""}
              onChange={(event) => updateDate("deadline", event.target.value || null)}
            />
          </label>
          <label>
            <span>
              <Flag size={15} />
              Priority
            </span>
            <select
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
        </section>

        <div className="date-shortcuts" aria-label="Schedule shortcuts">
          <button onClick={() => updateDate("scheduledFor", localDate())}>Today</button>
          <button onClick={() => updateDate("scheduledFor", tomorrowDate())}>Tomorrow</button>
          <button onClick={() => updateDate("scheduledFor", null)}>No date</button>
        </div>

        <section className="notes-section">
          <div className="section-heading">
            <span>
              <ListChecks size={16} />
              Notes
            </span>
            <small className={`content-status status-${content?.status ?? "idle"}`}>
              {contentLabel(content?.status)}
            </small>
          </div>
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
              placeholder="Add context, links, or the next step…"
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

        <footer className="inspector-footer">
          <span>{todo.notionPageId ? "Connected to Notion" : "Waiting to create Notion page"}</span>
          {!confirmDelete ? (
            <button className="danger-text" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} />
              Delete
            </button>
          ) : (
            <span className="delete-confirm">
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button
                className="danger-fill"
                onClick={() => {
                  workspace.collection.delete(todo.id);
                  onDeleted();
                }}
              >
                Delete task
              </button>
            </span>
          )}
        </footer>
      </div>
      {content?.pending && (
        <button className="flush-button" onClick={() => void workspace.content.flush(todo.id)}>
          <RefreshCw size={14} />
          Save now
        </button>
      )}
    </aside>
  );
}
