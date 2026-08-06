import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultGeneratedPath,
  ignoreDefaultEnvFile,
  loadCliEnvironment,
  saveInitEnvironment,
  updateEnvFile,
} from '../src/cli-config.js'

const originalPat = process.env.NOTION_PAT
const originalSourceId = process.env.NOTION_DATA_SOURCE_ID

afterEach(() => {
  if (originalPat === undefined) delete process.env.NOTION_PAT
  else process.env.NOTION_PAT = originalPat
  if (originalSourceId === undefined) delete process.env.NOTION_DATA_SOURCE_ID
  else process.env.NOTION_DATA_SOURCE_ID = originalSourceId
})

describe('CLI conventions', () => {
  it('generates into src beside the default manifest', () => {
    expect(defaultGeneratedPath('/project/notion.schema.json')).toBe(
      '/project/src/notion.generated.ts',
    )
  })

  it('loads .env.local before .env without overwriting its values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-cli-env-'))
    try {
      delete process.env.NOTION_PAT
      delete process.env.NOTION_DATA_SOURCE_ID
      await writeFile(join(directory, '.env.local'), 'NOTION_PAT=local\n')
      await writeFile(
        join(directory, '.env'),
        'NOTION_PAT=base\nNOTION_DATA_SOURCE_ID=source-1\n',
      )

      loadCliEnvironment(undefined, directory)

      expect(process.env.NOTION_PAT).toBe('local')
      expect(process.env.NOTION_DATA_SOURCE_ID).toBe('source-1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('updates credentials without replacing unrelated environment values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-cli-write-'))
    const envPath = join(directory, '.env.local')
    try {
      await writeFile(envPath, 'OTHER=value\nNOTION_PAT=old\n')
      await updateEnvFile(envPath, {
        NOTION_PAT: 'ntn_new',
        NOTION_DATA_SOURCE_ID: 'source-1',
      })
      await ignoreDefaultEnvFile(envPath)

      expect(await readFile(envPath, 'utf8')).toBe(
        'OTHER=value\nNOTION_PAT="ntn_new"\nNOTION_DATA_SOURCE_ID="source-1"\n',
      )
      expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe(
        '.env.local\n',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists a resolved --id without rewriting an existing PAT', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notion-cli-init-'))
    const envPath = join(directory, '.env.local')
    try {
      await writeFile(envPath, 'NOTION_PAT=existing\n')

      await saveInitEnvironment(envPath, { dataSourceId: 'resolved-source' })

      expect(await readFile(envPath, 'utf8')).toBe(
        'NOTION_PAT=existing\nNOTION_DATA_SOURCE_ID="resolved-source"\n',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
