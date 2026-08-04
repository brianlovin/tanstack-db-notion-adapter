import { createCollection } from "@tanstack/react-db";
import { createNotionPageContentClient, notionCollectionOptions } from "tanstack-db-notion-adapter";
import { todoSchema } from "./todo-schema.generated";

export function createTodoWorkspace() {
  const collection = createCollection(
    notionCollectionOptions({
      id: "daylight-todos",
      endpoint: "/api/todos",
      schema: todoSchema,
      pageSize: 100,
      pollIntervalMs: 5 * 60_000,
      invalidationPollIntervalMs: 15_000,
      refreshOnWindowFocus: true,
    }),
  );
  const content = createNotionPageContentClient({
    id: "daylight-todos",
    endpoint: "/api/todos",
    debounceMs: 800,
  });
  return {
    collection,
    content,
    cleanup() {
      content.cleanup();
      void collection.cleanup();
    },
  };
}

export type TodoWorkspace = ReturnType<typeof createTodoWorkspace>;
export type TodoCollection = TodoWorkspace["collection"];
