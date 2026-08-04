import type {
  InferNotionInput,
  InferNotionOutput,
} from 'tanstack-db-notion-adapter'
import { noteSchema } from './note-schema.generated'

export { noteSchema }

export const noteKinds = ['Note', 'Journal'] as const

export type Note = InferNotionOutput<typeof noteSchema.fields>
export type NewNote = InferNotionInput<typeof noteSchema.fields>
