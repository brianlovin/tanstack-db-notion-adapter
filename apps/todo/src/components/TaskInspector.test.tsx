import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { NotionPageContentSnapshot } from "tanstack-db-notion-adapter";
import type { TodoWorkspace } from "../collection";
import type { Todo } from "../domain";
import { TaskInspector } from "./TaskInspector";

const todo: Todo = {
  id: "task-1",
  title: "Test task",
  list: "Inbox",
  scheduledFor: null,
  deadline: null,
  priority: "Medium",
  position: 1_000,
  completed: false,
  completedAt: null,
  createdAt: "2026-08-04T10:00:00.000Z",
  updatedAt: "2026-08-04T10:00:00.000Z",
  notionPageId: null,
  notionUrl: null,
};

describe("TaskInspector", () => {
  it("shows clean remote markdown even when its local edit revision is unchanged", async () => {
    let snapshot: NotionPageContentSnapshot = {
      key: todo.id,
      notionPageId: null,
      markdown: "",
      baseMarkdown: "",
      remoteMarkdown: null,
      revision: 0,
      pending: false,
      truncated: false,
      unknownBlockIds: [],
      status: "idle",
      lastSyncedAt: null,
      error: null,
    };
    const listeners = new Set<() => void>();
    const workspace = {
      collection: { update: vi.fn(), delete: vi.fn() },
      content: {
        ready: vi.fn(async () => undefined),
        get: vi.fn(() => snapshot),
        subscribe: vi.fn((listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      },
    } as unknown as TodoWorkspace;
    render(
      <TaskInspector
        workspace={workspace}
        todo={todo}
        completing={false}
        closing={false}
        onToggleComplete={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    snapshot = {
      ...snapshot,
      markdown: "Loaded from Notion",
      baseMarkdown: "Loaded from Notion",
      status: "synced",
    };
    await act(async () => {
      for (const listener of listeners) listener();
    });

    expect(screen.getByLabelText("Task notes")).toHaveValue("Loaded from Notion");
  });
});
