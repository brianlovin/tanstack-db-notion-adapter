#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const json = args.includes('--json')
const manifestPath = resolve(option('--manifest', 'notion.schema.json'))
const findings = []

const add = (level, check, message) => findings.push({ level, check, message })

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const manifestText = await readOptional(manifestPath)
if (!manifestText) {
  add('error', 'manifest', `Manifest not found: ${manifestPath}`)
} else {
  try {
    const manifest = JSON.parse(manifestText)
    if (manifest.version !== 1) add('error', 'manifest', 'Expected manifest version 1.')
    if (!identifier.test(manifest.exportName ?? '')) {
      add('error', 'manifest', 'exportName is not a valid TypeScript identifier.')
    }
    if (!identifier.test(manifest.syncKey?.key ?? '')) {
      add('error', 'manifest', 'syncKey.key is not a valid TypeScript identifier.')
    }
    if (!Array.isArray(manifest.properties)) {
      add('error', 'manifest', 'properties must be an array.')
    } else {
      const keys = new Set()
      const names = new Set()
      for (const property of manifest.properties) {
        if (!identifier.test(property?.key ?? '')) {
          add('error', 'manifest', `Invalid property key: ${String(property?.key)}`)
        }
        if (keys.has(property?.key)) {
          add('error', 'manifest', `Duplicate property key: ${String(property?.key)}`)
        }
        if (names.has(property?.name)) {
          add('error', 'manifest', `Duplicate Notion property name: ${String(property?.name)}`)
        }
        keys.add(property?.key)
        names.add(property?.name)
      }
    }
    if (!findings.some((finding) => finding.level === 'error')) {
      add('ok', 'manifest', `Manifest parsed: ${manifestPath}`)
    }
    add(
      manifest.dataSourceId ? 'ok' : 'warning',
      'data-source',
      manifest.dataSourceId
        ? 'Manifest contains a non-secret data source ID.'
        : 'Manifest has no dataSourceId yet; pull or push will populate it.',
    )
  } catch {
    add('error', 'manifest', 'Manifest is not valid JSON.')
  }
}

const explicitEnv = args.includes('--env')
const configuredEnvPath = resolve(option('--env', '.env.local'))
let envPath = configuredEnvPath
let envText = await readOptional(envPath)
if (!explicitEnv && !envText) {
  envPath = resolve('.env')
  envText = await readOptional(envPath)
}
if (!envText) {
  add('warning', 'environment', `Env file not found: ${envPath}`)
} else {
  const keys = new Set(
    envText
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter(Boolean),
  )
  const hasToken = keys.has('NOTION_PAT') || keys.has('NOTION_TOKEN')
  const hasSource =
    keys.has('NOTION_DATA_SOURCE_ID') || keys.has('NOTION_DATABASE_ID')
  add(
    hasToken ? 'ok' : 'error',
    'environment',
    hasToken ? 'A Notion token key is present (value not read).' : 'No Notion token key is present.',
  )
  add(
    hasSource ? 'ok' : 'error',
    'environment',
    hasSource ? 'A Notion source/database key is present (value not read).' : 'No source/database ID key is present.',
  )
}

if (json) {
  process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`)
} else {
  for (const finding of findings) {
    process.stdout.write(`[${finding.level.toUpperCase()}] ${finding.check}: ${finding.message}\n`)
  }
}

process.exitCode = findings.some((finding) => finding.level === 'error') ? 1 : 0
