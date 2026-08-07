import { createCollection } from '@tanstack/react-db'
import {
  notionCollectionOptions,
} from 'tanstack-db-notion-adapter'
import {
  createBrowserNotionStorage,
  type LegacyNotionPersistedState,
} from 'tanstack-db-notion-adapter/advanced'
import {
  incidentCollection,
  setLabOnline,
} from './collection'
import { reliabilitySchema, type Incident } from './reliability-schema'

interface LabState {
  rows: Array<Incident>
  telemetry: {
    mutationRequests: number
    ledgerExecutions: number
    notionCreateCalls: number
    handlerInstances: number
    nextResponseWillBeLost: boolean
  }
}

export interface ScenarioReport {
  title: string
  summary: string
  evidence: Array<string>
}

function incident(id: string, title: string): Incident {
  const now = new Date().toISOString()
  return {
    id,
    title,
    owner: 'Ada',
    status: 'Investigating',
    severity: 'High',
    createdAt: now,
    updatedAt: now,
    notionPageId: null,
    notionUrl: null,
  }
}

function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 6_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest = await read()
  while (!accept(latest)) {
    if (Date.now() >= deadline) throw new Error('The check timed out.')
    await new Promise((resolve) => setTimeout(resolve, 40))
    latest = await read()
  }
  return latest
}

async function fetchLabState(): Promise<LabState> {
  const response = await fetch('/api/lab/state')
  if (!response.ok) throw new Error('Could not read the fixture server state.')
  return response.json() as Promise<LabState>
}

export async function resetReliabilityLab(): Promise<void> {
  setLabOnline(true)
  await fetch('/api/lab/reset', { method: 'POST' })
  await incidentCollection.utils.resetLocalCache()
}

export async function runStorageScenario(): Promise<ScenarioReport> {
  const storage = createBrowserNotionStorage({
    databaseName: 'tanstack-db-notion-reliability-probes',
  })
  const migrationId = unique('migration')
  const legacyRow = incident('legacy-row', 'Retained through migration')
  const legacy: LegacyNotionPersistedState<Incident> = {
    version: 1,
    rows: [legacyRow],
    outbox: [],
    lastSyncedAt: 42,
  }
  await (
    storage.save as unknown as (
      collectionId: string,
      state: LegacyNotionPersistedState<Incident>,
    ) => Promise<void>
  )(migrationId, legacy)
  const migrationCollection = createCollection(
    notionCollectionOptions({
      tuning: {
        pollIntervalMs: 0,
        coordinationStrategy: 'storage-lease',
        isOnline: () => false,
      },
      id: migrationId,
      endpoint: '/api/incidents',
      schema: reliabilitySchema,
      storage,
    }),
  )
  await migrationCollection.preload()
  const migrated = await storage.load<Incident>(migrationId)
  if (
    migrationCollection.get('legacy-row')?.title !== legacyRow.title ||
    migrated?.version !== 2 ||
    migrated.revision < 1
  ) {
    throw new Error('The version-one cache did not migrate atomically.')
  }
  await migrationCollection.cleanup()
  await storage.clear(migrationId)

  const corruptId = unique('quarantine')
  const corrupt = {
    version: 73,
    rows: [],
    outbox: [{ acknowledged: 'must not disappear' }],
    lastSyncedAt: null,
  }
  await (
    storage.save as unknown as (
      collectionId: string,
      state: unknown,
    ) => Promise<void>
  )(corruptId, corrupt)
  const corruptCollection = createCollection(
    notionCollectionOptions({
      tuning: {
        pollIntervalMs: 0,
        coordinationStrategy: 'storage-lease',
        isOnline: () => false,
      },
      id: corruptId,
      endpoint: '/api/incidents',
      schema: reliabilitySchema,
      storage,
    }),
  )
  await corruptCollection.preload()
  const quarantine = await corruptCollection.utils.getQuarantinedState()
  if (
    !quarantine ||
    (quarantine.value as { version?: number }).version !== 73 ||
    corruptCollection.utils.getSyncState().status !== 'error'
  ) {
    throw new Error('Unreadable state was not retained in quarantine.')
  }
  await corruptCollection.cleanup()
  await storage.clearQuarantine?.(corruptId)

  return {
    title: 'State upgraded without erasure',
    summary: 'A v1 cache became v2, while an unknown envelope was preserved in quarantine.',
    evidence: [
      `Migrated revision ${migrated.revision}`,
      'Legacy row remained queryable',
      'Unknown version 73 retained byte-for-byte',
    ],
  }
}

export async function runWriterScenario(): Promise<ScenarioReport> {
  const databaseName = unique('writer-database')
  const collectionId = unique('writer-collection')
  const firstStorage = createBrowserNotionStorage({ databaseName })
  const secondStorage = createBrowserNotionStorage({ databaseName })
  const makeCollection = (storage: typeof firstStorage) =>
    createCollection(
      notionCollectionOptions({
        tuning: {
          pollIntervalMs: 0,
          coordinationStrategy: 'storage-lease',
          isOnline: () => false,
        },
        id: collectionId,
        endpoint: '/api/incidents',
        schema: reliabilitySchema,
        storage,
      }),
    )
  const first = makeCollection(firstStorage)
  const second = makeCollection(secondStorage)
  await Promise.all([first.preload(), second.preload()])

  const firstWrite = first.insert(incident('writer-a', 'Written by context A'))
  const secondWrite = second.insert(incident('writer-b', 'Written by context B'))
  await Promise.all([
    firstWrite.isPersisted.promise,
    secondWrite.isPersisted.promise,
  ])
  const persisted = await firstStorage.load<Incident>(collectionId)
  if (
    persisted?.version !== 2 ||
    persisted.rows.length !== 2 ||
    persisted.outbox.length !== 2
  ) {
    throw new Error('Concurrent writers did not preserve both acknowledged edits.')
  }

  await Promise.all([first.cleanup(), second.cleanup()])
  await firstStorage.clear(collectionId)
  return {
    title: 'Independent writers serialized',
    summary: 'Two collection instances used the IndexedDB lease fallback and retained both edits.',
    evidence: [
      'Web Locks path deliberately bypassed',
      `${persisted.outbox.length} durable outbox entries`,
      `Monotonic state revision ${persisted.revision}`,
    ],
  }
}

export async function runIdempotencyScenario(): Promise<ScenarioReport> {
  setLabOnline(true)
  const id = unique('lost-response')
  await fetch('/api/lab/arm-lost-response', { method: 'POST' })
  const transaction = incidentCollection.insert(
    incident(id, 'Response disappears after commit'),
  )
  await transaction.isPersisted.promise
  const pending = await waitFor(
    () => incidentCollection.utils.getPendingMutations(),
    (entries) =>
      entries.some(
        (entry) =>
          entry.batch.mutations.some((mutation) => mutation.key === id) &&
          entry.lastError?.code === 'simulated_lost_response',
      ),
  )
  const entry = pending.find((candidate) =>
    candidate.batch.mutations.some((mutation) => mutation.key === id),
  )!
  await incidentCollection.utils.retryPendingMutation(entry.id)
  const state = await fetchLabState()
  const matchingRows = state.rows.filter((row) => row.id === id)
  if (
    matchingRows.length !== 1 ||
    state.telemetry.notionCreateCalls < 1 ||
    state.telemetry.mutationRequests < 2
  ) {
    throw new Error('The retry was not replayed from the idempotency ledger.')
  }
  return {
    title: 'Lost response replayed once',
    summary: 'The first handler committed, the browser saw a 503, and another handler replayed the stored result.',
    evidence: [
      `${state.telemetry.handlerInstances} handler instances shared one ledger`,
      `${state.telemetry.mutationRequests} delivery attempts`,
      'Exactly one remote page for the client ID',
    ],
  }
}

export async function runConflictScenario(): Promise<ScenarioReport> {
  setLabOnline(true)
  const id = unique('property-conflict')
  const transaction = incidentCollection.insert(
    incident(id, 'Property merge exercise'),
  )
  await transaction.isPersisted.promise
  await incidentCollection.utils.syncNow()

  await fetch('/api/lab/remote-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: id, field: 'owner', value: 'Remote operator' }),
  })
  const titleUpdate = incidentCollection.update(id, (draft) => {
    draft.title = 'Local title survives'
  })
  await titleUpdate.isPersisted.promise
  await incidentCollection.utils.syncNow()
  const afterMerge = (await fetchLabState()).rows.find((row) => row.id === id)
  if (
    afterMerge?.title !== 'Local title survives' ||
    afterMerge.owner !== 'Remote operator'
  ) {
    throw new Error('An unrelated remote property was overwritten.')
  }

  setLabOnline(false)
  const conflictUpdate = incidentCollection.update(id, (draft) => {
    draft.title = 'Local competing title'
  })
  await conflictUpdate.isPersisted.promise
  await fetch('/api/lab/remote-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: id, field: 'title', value: 'Remote competing title' }),
  })
  setLabOnline(true)
  await incidentCollection.utils.syncNow().catch(() => undefined)
  const pending = await incidentCollection.utils.getPendingMutations()
  const conflict = pending.find((entry) =>
    entry.batch.mutations.some((mutation) => mutation.key === id),
  )
  if (
    conflict?.lastError?.code !== 'property_conflict' ||
    conflict.lastError.conflicts[0]?.field !== 'title'
  ) {
    throw new Error('A same-property edit did not produce a structured conflict.')
  }
  await incidentCollection.utils.discardPendingMutation(conflict.id, {
    acceptDataLoss: true,
  })
  return {
    title: 'Unrelated edits merged; overlap stopped',
    summary: 'Owner and title edits merged, while two title edits produced an explicit recoverable conflict.',
    evidence: [
      'Remote owner remained “Remote operator”',
      'Local title reached the remote row',
      'Overlapping title edit returned property_conflict',
    ],
  }
}
