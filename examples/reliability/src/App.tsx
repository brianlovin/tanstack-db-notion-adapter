import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import type { NotionSyncState } from 'tanstack-db-notion-adapter'
import {
  incidentCollection,
  isLabOnline,
  setLabOnline,
} from './collection'
import {
  resetReliabilityLab,
  runConflictScenario,
  runIdempotencyScenario,
  runStorageScenario,
  runWriterScenario,
  type ScenarioReport,
} from './scenarios'
import {
  incidentSeverities,
  incidentStatuses,
  type Incident,
} from './reliability-schema'

type ScenarioKey = 'storage' | 'writers' | 'idempotency' | 'conflicts'
type ScenarioStatus = 'ready' | 'running' | 'passed' | 'failed'

interface ScenarioDefinition {
  key: ScenarioKey
  title: string
  description: string
  run: () => Promise<ScenarioReport>
}

const fallbackSyncState: NotionSyncState = {
  status: 'idle',
  progress: null,
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: 'indexeddb',
  error: null,
  quarantine: null,
}

const initialStatuses: Record<ScenarioKey, ScenarioStatus> = {
  storage: 'ready',
  writers: 'ready',
  idempotency: 'ready',
  conflicts: 'ready',
}

const scenarios: Array<ScenarioDefinition> = [
  {
    key: 'storage',
    title: 'Storage recovery',
    description: 'Migrates known state and quarantines unknown state.',
    run: runStorageScenario,
  },
  {
    key: 'writers',
    title: 'Concurrent writers',
    description: 'Serializes edits from independent browser contexts.',
    run: runWriterScenario,
  },
  {
    key: 'idempotency',
    title: 'Idempotent retry',
    description: 'Retries a lost create response without duplicating data.',
    run: runIdempotencyScenario,
  },
  {
    key: 'conflicts',
    title: 'Property conflicts',
    description: 'Merges unrelated edits and stops overlapping changes.',
    run: runConflictScenario,
  },
]

function useSyncState(): NotionSyncState {
  return useSyncExternalStore(
    incidentCollection.utils.subscribeSyncState,
    incidentCollection.utils.getSyncState,
    () => fallbackSyncState,
  )
}

function ScenarioRow({
  scenario,
  status,
  report,
  disabled,
  onRun,
}: {
  scenario: ScenarioDefinition
  status: ScenarioStatus
  report?: ScenarioReport
  disabled: boolean
  onRun: () => void
}) {
  return (
    <li className="scenario-row">
      <span className={`scenario-status status-${status}`} aria-label={status} />
      <div>
        <strong>{scenario.title}</strong>
        <p>{scenario.description}</p>
        {report ? (
          <details>
            <summary>{report.title}</summary>
            <ul>
              {report.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <button type="button" disabled={disabled} onClick={onRun}>
        {status === 'running' ? 'Running…' : status === 'passed' ? 'Run again' : 'Run'}
      </button>
    </li>
  )
}

function IncidentComposer() {
  const [title, setTitle] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextTitle = title.trim()
    if (!nextTitle) return
    incidentCollection.insert({
      title: nextTitle,
      owner: 'On-call',
      severity: 'Low',
      status: 'Investigating',
    })
    setTitle('')
  }

  return (
    <form className="incident-composer" onSubmit={submit}>
      <input
        aria-label="New incident"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="New incident"
      />
      <button type="submit" disabled={!title.trim()}>
        Add
      </button>
    </form>
  )
}

function IncidentRow({ incident }: { incident: Incident }) {
  return (
    <li className="incident-row">
      <input
        aria-label={`Title for ${incident.title}`}
        value={incident.title}
        onChange={(event) => {
          const value = event.target.value
          incidentCollection.update(incident.id, (draft) => {
            draft.title = value
          })
        }}
      />
      <select
        aria-label={`Status for ${incident.title}`}
        value={incident.status ?? ''}
        onChange={(event) =>
          incidentCollection.update(incident.id, (draft) => {
            draft.status = event.target.value as Incident['status']
          })
        }
      >
        {incidentStatuses.map((status) => (
          <option key={status}>{status}</option>
        ))}
      </select>
      <select
        aria-label={`Severity for ${incident.title}`}
        value={incident.severity ?? ''}
        onChange={(event) =>
          incidentCollection.update(incident.id, (draft) => {
            draft.severity = event.target.value as Incident['severity']
          })
        }
      >
        {incidentSeverities.map((severity) => (
          <option key={severity}>{severity}</option>
        ))}
      </select>
    </li>
  )
}

export function App() {
  const syncState = useSyncState()
  const [online, setOnline] = useState(() => isLabOnline())
  const [running, setRunning] = useState<ScenarioKey | 'all' | null>(null)
  const [statuses, setStatuses] = useState(initialStatuses)
  const [reports, setReports] = useState<
    Partial<Record<ScenarioKey, ScenarioReport>>
  >({})
  const { data: incidents = [], isLoading } = useLiveQuery((query) =>
    query
      .from({ incident: incidentCollection })
      .orderBy(({ incident }) => incident.createdAt, 'desc'),
  )

  const runScenario = async (scenario: ScenarioDefinition) => {
    setRunning(scenario.key)
    setStatuses((current) => ({ ...current, [scenario.key]: 'running' }))
    try {
      const report = await scenario.run()
      setReports((current) => ({ ...current, [scenario.key]: report }))
      setStatuses((current) => ({ ...current, [scenario.key]: 'passed' }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The check failed.'
      setReports((current) => ({
        ...current,
        [scenario.key]: { title: message, summary: message, evidence: [] },
      }))
      setStatuses((current) => ({ ...current, [scenario.key]: 'failed' }))
    } finally {
      setRunning(null)
      setOnline(isLabOnline())
    }
  }

  const runAll = async () => {
    setRunning('all')
    for (const scenario of scenarios) {
      setStatuses((current) => ({ ...current, [scenario.key]: 'running' }))
      try {
        const report = await scenario.run()
        setReports((current) => ({ ...current, [scenario.key]: report }))
        setStatuses((current) => ({ ...current, [scenario.key]: 'passed' }))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The check failed.'
        setReports((current) => ({
          ...current,
          [scenario.key]: { title: message, summary: message, evidence: [] },
        }))
        setStatuses((current) => ({ ...current, [scenario.key]: 'failed' }))
        break
      }
    }
    setRunning(null)
    setOnline(isLabOnline())
  }

  const toggleOnline = () => {
    const next = !online
    setLabOnline(next)
    setOnline(next)
    if (next) void incidentCollection.utils.syncNow().catch(() => undefined)
  }

  const reset = async () => {
    setRunning('all')
    try {
      await resetReliabilityLab()
      setStatuses(initialStatuses)
      setReports({})
    } finally {
      setRunning(null)
      setOnline(true)
    }
  }

  return (
    <main className="page">
      <header>
        <div>
          <h1>Reliability</h1>
          <p>Four checks for the adapter's durable sync guarantees.</p>
        </div>
        <div className="actions">
          <button type="button" onClick={toggleOnline}>
            {online ? 'Go offline' : 'Go online'}
          </button>
          <button type="button" onClick={reset} disabled={running !== null}>
            Reset
          </button>
          <button type="button" onClick={runAll} disabled={running !== null}>
            {running === 'all' ? 'Running…' : 'Run all'}
          </button>
        </div>
      </header>

      <section aria-labelledby="checks-heading">
        <h2 id="checks-heading">Checks</h2>
        <ul className="scenario-list">
          {scenarios.map((scenario) => (
            <ScenarioRow
              key={scenario.key}
              scenario={scenario}
              status={statuses[scenario.key]}
              {...(reports[scenario.key] ? { report: reports[scenario.key] } : {})}
              disabled={running !== null}
              onRun={() => void runScenario(scenario)}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="incidents-heading">
        <div className="section-heading">
          <h2 id="incidents-heading">Shared collection</h2>
          <span>
            {syncState.status} · {syncState.pendingMutations} pending
          </span>
        </div>
        <IncidentComposer />
        {isLoading ? (
          <p className="empty">Loading…</p>
        ) : incidents.length === 0 ? (
          <p className="empty">No incidents.</p>
        ) : (
          <ul className="incident-list">
            {incidents.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
