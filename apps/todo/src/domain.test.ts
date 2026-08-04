import { describe, expect, it } from "vite-plus/test";
import {
  localDate,
  parseQuickTask,
  taskCounts,
  taskMatchesView,
  visibleTasks,
  type Todo,
} from "./domain";

const now = new Date(2026, 7, 4, 10, 0, 0);

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: "Test task",
    list: "Inbox",
    scheduledFor: null,
    deadline: null,
    priority: "Medium",
    position: 1_000,
    completed: false,
    completedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    notionPageId: null,
    notionUrl: null,
    ...overrides,
  };
}

describe("task domain", () => {
  it("treats legacy rows without a list as inbox tasks", () => {
    expect(taskMatchesView(todo({ list: null }), "inbox", localDate(now))).toBe(true);
  });

  it("puts overdue scheduled tasks in Today and future tasks in Upcoming", () => {
    const overdue = todo({ scheduledFor: "2026-08-03" });
    const future = todo({ scheduledFor: "2026-08-05" });
    expect(taskMatchesView(overdue, "today", "2026-08-04")).toBe(true);
    expect(taskMatchesView(future, "today", "2026-08-04")).toBe(false);
    expect(taskMatchesView(future, "upcoming", "2026-08-04")).toBe(true);
  });

  it("parses quick-entry directives without leaving command text in the title", () => {
    expect(parseQuickTask("Write release notes @tomorrow @anytime !high", "inbox", now)).toEqual({
      title: "Write release notes",
      list: "Anytime",
      scheduledFor: "2026-08-05",
      priority: "High",
    });
    expect(parseQuickTask("Maybe learn pottery @someday", "today", now)).toEqual({
      title: "Maybe learn pottery",
      list: "Someday",
      scheduledFor: null,
      priority: "Medium",
    });
  });

  it("filters and sorts thousands of local rows deterministically", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) =>
      todo({
        id: `task-${index}`,
        title: index % 100 === 0 ? `Needle ${index}` : `Task ${index}`,
        list: index % 2 === 0 ? "Inbox" : "Anytime",
        position: 10_000 - index,
      }),
    );
    const matches = visibleTasks(rows, "inbox", "needle", "2026-08-04");
    expect(matches).toHaveLength(100);
    expect(matches[0]?.id).toBe("task-9900");
    expect(taskCounts(rows, "2026-08-04").all).toBe(10_000);
  });
});
