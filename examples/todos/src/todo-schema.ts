import type {
  InferNotionInput,
  InferNotionOutput,
} from 'tanstack-db-notion-adapter'
import { todoSchema } from './todo-schema.generated'

export { todoSchema }

export const priorities = ['Low', 'Medium', 'High'] as const

export type Todo = InferNotionOutput<typeof todoSchema.fields>
export type NewTodo = InferNotionInput<typeof todoSchema.fields>
