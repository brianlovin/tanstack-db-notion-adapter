import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import type { NotionSyncState } from 'tanstack-db-notion-adapter'
import {
  incidentCollection,
  isLabOnline,
  setLabOnline,
} from './collection'
import {
  fetchLabState,
  inspectPersistedState,
  resetReliabilityLab,
  runConflictScenario,
  runIdempotencyScenario,
  runStorageScenario,
  runWriterScenario,
  type LabState,
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
  number: string
  eyebrow: string
  title: string
  promise: string
  run: () => Promise<ScenarioReport>
}

interface FlightEvent {
  id: string
  time: string
  tone: 'neutral' | 'active' | 'pass' | 'fail'
  message: string
}

const fallbackSyncState: NotionSyncState = {
  status: 'idle',
  pendingMutations: 0,
  lastSyncedAt: null,
  remoteVersion: null,
  isOnline: true,
  storage: 'indexeddb',
  error: null,
  quarantine: null,
}

const scenarios: Array<ScenarioDefinition> = [
  {
    key: 'storage',
    number: '01',
    eyebrow: 'Persistence envelope',
    title: 'Upgrade or quarantine',
    promise: 'Old state migrates. Unknown state is retained, never erased.',
    run: runStorageScenario,
  },
  {
    key: 'writers',
    number: '02',
    eyebrow: 'Browser coordination',
    title: 'Serialize every writer',
    promise: 'Independent contexts cannot overwrite one another’s outbox.',
    run: runWriterScenario,
  },
  {
    key: 'idempotency',
    number: '03',
    eyebrow: 'Server boundary',
    title: 'Create exactly once',
    promise: 'A lost response can retry through another server instance safely.',
    run: runIdempotencyScenario,
  },
  {
    key: 'conflicts',
    number: '04',
    eyebrow: 'Property merge',
    title: 'Merge without clobbering',
    promise: 'Unrelated fields merge; overlapping edits stop with evidence.',
    run: runConflictScenario,
  },
]

function timeLabel(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date())
}

function useSyncState(): NotionSyncState {
  return useSyncExternalStore(
    incidentCollection.utils.subscribeSyncState,
    incidentCollection.utils.getSyncState,
    () => fallbackSyncState,
  )
}

function StatusMark({ status }: { status: ScenarioStatus }) {
  return (
    <span className={`status-mark status-${status}`} aria-label={status}>
      {status === 'passed' ? '✓' : status === 'failed' ? '!' : ''}
    </span>
  )
}

function scenarioActionLabel(status: ScenarioStatus): string {
  if (status === 'running') return 'Running check…'
  if (status === 'passed') return 'Run again'
  return 'Run check'
}

function ScenarioCard({
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
    <article className={`scenario-card scenario-${status}`}>
      <div className="scenario-index">
        <span>{scenario.number}</span>
        <StatusMark status={status} />
      </div>
      <p className="eyebrow">{scenario.eyebrow}</p>
      <h2>{scenario.title}</h2>
      <p className="scenario-promise">{scenario.promise}</p>
      {report ? (
        <div className="scenario-evidence">
          <strong>{report.title}</strong>
          <ul>
            {report.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        className="scenario-action"
        type="button"
        disabled={disabled}
        onClick={onRun}
        data-testid={`run-${scenario.key}`}
      >
        {scenarioActionLabel(status)}
      </button>
    </article>
  )
}

function IncidentComposer() {
  const [title, setTitle] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    incidentCollection.insert({
      title: title.trim(),
      owner: 'On-call',
      severity: 'Low',
      status: 'Investigating',
    })
    setTitle('')
  }

  return (
    <form className="incident-composer" onSubmit={submit}>
      <label htmlFor="incident-title">New incident</label>
      <div>
        <input
          id="incident-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Describe a reliability event"
        />
        <button type="submit" disabled={!title.trim()}>
          Record
        </button>
      </div>
    </form>
  )
}

function IncidentRow({ incident }: { incident: Incident }) {
  return (
    <li className="incident-row">
      <span className={`severity severity-${incident.severity?.toLowerCase()}`}>
        {incident.severity}
      </span>
      <div className="incident-copy">
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
        <small>
          {incident.owner} · {incident.notionPageId ? 'remote page' : 'local draft'}
        </small>
      </div>
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
  const [online, setOnline] = useState(isLabOnline())
  const [running, setRunning] = useState<ScenarioKey | 'all' | null>(null)
  const [statuses, setStatuses] = useState<Record<ScenarioKey, ScenarioStatus>>({
    storage: 'ready',
    writers: 'ready',
    idempotency: 'ready',
    conflicts: 'ready',
  })
  const [reports, setReports] = useState<
    Partial<Record<ScenarioKey, ScenarioReport>>
  >({})
  const [events, setEvents] = useState<Array<FlightEvent>>([
    {
      id: crypto.randomUUID(),
      time: timeLabel(),
      tone: 'neutral',
      message: 'Lab ready. Checks use the same public adapter APIs as an application.',
    },
  ])
  const [serverState, setServerState] = useState<LabState | null>(null)
  const [persistedRevision, setPersistedRevision] = useState<number | null>(null)
  const { data: incidents = [], isLoading } = useLiveQuery((query) =>
    query
      .from({ incident: incidentCollection })
      .orderBy(({ incident }) => incident.createdAt, 'desc'),
  )

  const appendEvent = (tone: FlightEvent['tone'], message: string) => {
    setEvents((current) => [
      { id: crypto.randomUUID(), time: timeLabel(), tone, message },
      ...current.slice(0, 11),
    ])
  }

  const refreshTelemetry = async () => {
    const [remote, persisted] = await Promise.all([
      fetchLabState(),
      inspectPersistedState(),
    ])
    setServerState(remote)
    setPersistedRevision(persisted?.revision ?? null)
  }

  useEffect(() => {
    void refreshTelemetry().catch(() => undefined)
    const interval = setInterval(() => {
      void refreshTelemetry().catch(() => undefined)
    }, 1_000)
    return () => clearInterval(interval)
  }, [])

  const runScenario = async (scenario: ScenarioDefinition) => {
    setRunning(scenario.key)
    setStatuses((current) => ({ ...current, [scenario.key]: 'running' }))
    appendEvent('active', `${scenario.number} ${scenario.title} started.`)
    try {
      const report = await scenario.run()
      setReports((current) => ({ ...current, [scenario.key]: report }))
      setStatuses((current) => ({ ...current, [scenario.key]: 'passed' }))
      appendEvent('pass', `${scenario.number} passed — ${report.summary}`)
      await refreshTelemetry()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The check failed.'
      setStatuses((current) => ({ ...current, [scenario.key]: 'failed' }))
      appendEvent('fail', `${scenario.number} failed — ${message}`)
    } finally {
      setRunning(null)
      setOnline(isLabOnline())
    }
  }

  const runAll = async () => {
    setRunning('all')
    appendEvent('active', 'Full four-guarantee sequence started.')
    for (const scenario of scenarios) {
      setStatuses((current) => ({ ...current, [scenario.key]: 'running' }))
      try {
        const report = await scenario.run()
        setReports((current) => ({ ...current, [scenario.key]: report }))
        setStatuses((current) => ({ ...current, [scenario.key]: 'passed' }))
        appendEvent('pass', `${scenario.number} passed — ${report.title}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The check failed.'
        setStatuses((current) => ({ ...current, [scenario.key]: 'failed' }))
        appendEvent('fail', `${scenario.number} failed — ${message}`)
        break
      }
    }
    setRunning(null)
    setOnline(isLabOnline())
    await refreshTelemetry().catch(() => undefined)
  }

  const passedCount = useMemo(
    () => Object.values(statuses).filter((status) => status === 'passed').length,
    [statuses],
  )

  const toggleOnline = () => {
    const next = !online
    setLabOnline(next)
    setOnline(next)
    appendEvent(next ? 'active' : 'neutral', next ? 'Network resumed.' : 'Adapter network paused.')
    if (next) void incidentCollection.utils.syncNow().catch(() => undefined)
  }

  const reset = async () => {
    setRunning('all')
    try {
      await resetReliabilityLab()
      setStatuses({
        storage: 'ready',
        writers: 'ready',
        idempotency: 'ready',
        conflicts: 'ready',
      })
      setReports({})
      setEvents([
        {
          id: crypto.randomUUID(),
          time: timeLabel(),
          tone: 'neutral',
          message: 'Local cache, remote fixture, and idempotency ledger reset.',
        },
      ])
      await refreshTelemetry()
    } finally {
      setRunning(null)
      setOnline(true)
    }
  }

  return (
    <main className="lab-shell">
      <header className="lab-header">
        <div className="lab-identity">
          <span className="lab-symbol" aria-hidden="true">
            R/4
          </span>
          <div>
            <p className="eyebrow">TanStack DB × Notion</p>
            <h1>Reliability lab</h1>
          </div>
        </div>
        <div className="header-instruments">
          <button
            className={`network-switch ${online ? 'is-online' : 'is-offline'}`}
            type="button"
            onClick={toggleOnline}
          >
            <span /> {online ? 'Network live' : 'Network paused'}
          </button>
          <button
            className="quiet-button"
            type="button"
            onClick={() => window.open(location.href, '_blank')}
          >
            Open mirror tab
          </button>
          <button
            className="quiet-button"
            type="button"
            onClick={reset}
            disabled={running !== null}
          >
            Reset lab
          </button>
          <button
            className="run-all"
            type="button"
            onClick={runAll}
            disabled={running !== null}
            data-testid="run-all"
          >
            {running === 'all' ? 'Sequence running…' : 'Run all four'}
          </button>
        </div>
      </header>

      <section className="lab-thesis" aria-labelledby="lab-thesis-title">
        <div>
          <p className="eyebrow">Four failure boundaries · one observable system</p>
          <h2 id="lab-thesis-title">
            Make the dangerous moment
            <span> visible.</span>
          </h2>
        </div>
        <p>
          Each check injects the failure it claims to survive, then inspects the
          durable browser state and simulated Notion wire protocol for evidence.
        </p>
        <div className="score-dial" aria-label={`${passedCount} of 4 checks passed`}>
          <strong>{passedCount}</strong>
          <span>/ 4 passed</span>
        </div>
      </section>

      <section className="scenario-grid" aria-label="Reliability checks">
        {scenarios.map((scenario) => (
          <ScenarioCard
            key={scenario.key}
            scenario={scenario}
            status={statuses[scenario.key]}
            {...(reports[scenario.key]
              ? { report: reports[scenario.key] }
              : {})}
            disabled={running !== null}
            onRun={() => void runScenario(scenario)}
          />
        ))}
        <div className="signal-trace" aria-hidden="true">
          <span />
        </div>
      </section>

      <section className="workbench">
        <div className="incident-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Shared collection</p>
              <h2>Incident ledger</h2>
            </div>
            <div className="sync-readout">
              <span className={`sync-lamp sync-${syncState.status}`} />
              <strong>{syncState.status}</strong>
              <small>{syncState.pendingMutations} pending</small>
            </div>
          </div>
          <IncidentComposer />
          {isLoading ? (
            <p className="empty-copy">Opening the durable cache…</p>
          ) : incidents.length === 0 ? (
            <p className="empty-copy">
              Run a server-bound check or record an incident. Edits appear here
              before the network sees them.
            </p>
          ) : (
            <ul className="incident-list">
              {incidents.map((item) => (
                <IncidentRow key={item.id} incident={item} />
              ))}
            </ul>
          )}
        </div>

        <aside className="recorder-panel">
          <div className="panel-heading recorder-heading">
            <div>
              <p className="eyebrow">Append-only readout</p>
              <h2>Flight recorder</h2>
            </div>
            <span className="recording-light">REC</span>
          </div>
          <dl className="telemetry-strip">
            <div>
              <dt>Local revision</dt>
              <dd>{persistedRevision ?? '—'}</dd>
            </div>
            <div>
              <dt>Mutation deliveries</dt>
              <dd>{serverState?.telemetry.mutationRequests ?? 0}</dd>
            </div>
            <div>
              <dt>Notion creates</dt>
              <dd>{serverState?.telemetry.notionCreateCalls ?? 0}</dd>
            </div>
          </dl>
          <ol className="event-log" aria-live="polite">
            {events.map((event) => (
              <li key={event.id} className={`event-${event.tone}`}>
                <time>{event.time}</time>
                <p>{event.message}</p>
              </li>
            ))}
          </ol>
        </aside>
      </section>

      <footer>
        <span>Fixture Notion API · two rotating handler instances</span>
        <span>Storage path · IndexedDB lease + revision CAS</span>
      </footer>
    </main>
  )
}
