import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  NotionIdempotencyConflictError,
  type NotionIdempotencyOperation,
  type NotionIdempotencyStore,
} from 'tanstack-db-notion-adapter/server'

interface StoredOperation {
  fingerprint: string
  status: 'running' | 'complete'
  result_json: string | null
  owner: string
  lease_expires_at: number
}

const leaseDurationMs = 60_000

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * A durable, cross-process execution ledger for one host. SQLite elects one
 * owner before a Notion request begins, while a renewable lease permits crash
 * recovery.
 */
export function createSqliteIdempotencyStore(
  path: string,
): NotionIdempotencyStore {
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path, { timeout: 5_000 })
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS notion_idempotency (
      scope TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'complete')),
      result_json TEXT,
      owner TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, operation_key)
    ) STRICT;
  `)

  const read = database.prepare(`
    SELECT fingerprint, status, result_json, owner, lease_expires_at
    FROM notion_idempotency
    WHERE scope = ? AND operation_key = ?
  `)
  const claim = database.prepare(`
    INSERT INTO notion_idempotency (
      scope, operation_key, fingerprint, status, result_json, owner,
      lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, ?)
    ON CONFLICT(scope, operation_key) DO UPDATE SET
      status = 'running', result_json = NULL, owner = excluded.owner,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at
    WHERE notion_idempotency.fingerprint = excluded.fingerprint
      AND notion_idempotency.status = 'running'
      AND notion_idempotency.lease_expires_at <= excluded.updated_at
  `)
  const renew = database.prepare(`
    UPDATE notion_idempotency SET lease_expires_at = ?, updated_at = ?
    WHERE scope = ? AND operation_key = ? AND owner = ? AND status = 'running'
  `)
  const complete = database.prepare(`
    UPDATE notion_idempotency
    SET status = 'complete', result_json = ?, lease_expires_at = 0, updated_at = ?
    WHERE scope = ? AND operation_key = ? AND owner = ? AND status = 'running'
  `)
  const release = database.prepare(`
    DELETE FROM notion_idempotency
    WHERE scope = ? AND operation_key = ? AND owner = ? AND status = 'running'
  `)

  const acquire = (
    operation: NotionIdempotencyOperation,
    owner: string,
  ): { run: true } | { run: false; value?: unknown; waitMs?: number } => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = read.get(
        operation.scope,
        operation.key,
      ) as StoredOperation | undefined
      if (existing && existing.fingerprint !== operation.fingerprint) {
        throw new NotionIdempotencyConflictError()
      }
      if (existing?.status === 'complete') {
        const value = JSON.parse(existing.result_json ?? 'null') as unknown
        database.exec('COMMIT')
        return { run: false, value }
      }
      const now = Date.now()
      if (existing && existing.lease_expires_at > now) {
        database.exec('COMMIT')
        return {
          run: false,
          waitMs: Math.min(250, Math.max(25, existing.lease_expires_at - now)),
        }
      }
      claim.run(
        operation.scope,
        operation.key,
        operation.fingerprint,
        owner,
        now + leaseDurationMs,
        now,
        now,
      )
      database.exec('COMMIT')
      return { run: true }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  return {
    async execute<T>(
      operation: NotionIdempotencyOperation,
      run: () => Promise<T>,
    ) {
      const owner = randomUUID()
      while (true) {
        const result = acquire(operation, owner)
        if (!result.run) {
          if (result.waitMs) {
            await delay(result.waitMs)
            continue
          }
          return result.value as T
        }

        const renewal = setInterval(() => {
          const now = Date.now()
          renew.run(
            now + leaseDurationMs,
            now,
            operation.scope,
            operation.key,
            owner,
          )
        }, leaseDurationMs / 3)
        renewal.unref()
        try {
          const value = await run()
          const saved = complete.run(
            JSON.stringify(value),
            Date.now(),
            operation.scope,
            operation.key,
            owner,
          )
          if (saved.changes !== 1) {
            throw new Error('The idempotency execution lease was lost.')
          }
          return value
        } catch (error) {
          release.run(operation.scope, operation.key, owner)
          throw error
        } finally {
          clearInterval(renewal)
        }
      }
    },
  }
}
