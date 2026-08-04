import {
  notion,
  notionSchema,
  type InferNotionOutput,
} from 'tanstack-db-notion-adapter'

export const incidentStatuses = ['Investigating', 'Contained'] as const
export const incidentSeverities = ['Low', 'High'] as const

export const reliabilitySchema = notionSchema({
  id: notion.id('Client ID'),
  title: notion.title('Incident'),
  owner: notion.richText('Owner', 'Unassigned'),
  status: notion.select('Status', incidentStatuses, 'Investigating'),
  severity: notion.select('Severity', incidentSeverities, 'Low'),
  createdAt: notion.createdTime('Created'),
  updatedAt: notion.lastEditedTime('Updated'),
  notionPageId: notion.pageId(),
  notionUrl: notion.pageUrl(),
})

export type Incident = InferNotionOutput<typeof reliabilitySchema.fields>
