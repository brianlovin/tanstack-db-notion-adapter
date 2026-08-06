#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  defaultGeneratedPath,
  ignoreDefaultEnvFile,
  loadCliEnvironment,
  updateEnvFile,
} from './cli-config.js'
import {
  assertNotionSchemaManifest,
  createNotionSchemaManifest,
  diffNotionSchema,
  formatNotionSchemaDiff,
  formatNotionSchemaDrift,
  generateNotionSchemaSource,
  inspectNotionDataSource,
  pushNotionSchema,
} from './schema-tools.js'
import type { NotionSchemaManifest } from './schema-tools.js'

type Command =
  | 'init'
  | 'pull'
  | 'generate'
  | 'check'
  | 'push'
  | 'doctor'
  | 'help'
  | 'version'

interface CliOptions {
  command: Command
  envFile?: string
  manifestPath: string
  outputPath?: string
  id?: string
  exportName?: string
  syncKeyName?: string
  dryRun: boolean
  allowDestructive: boolean
  deprecatedAllowDestructive: boolean
}

const help = `tanstack-db-notion <command> [options]

Commands:
  init       Inspect a data source and create a manifest + generated schema
  pull       Merge the live Notion schema into the local manifest and regenerate
  generate   Generate TypeScript from the local manifest without calling Notion
  check      Exit non-zero when the local and remote schemas differ
  push       Update Notion, then pull stable property IDs
  doctor     Validate config, connectivity, source selection, and schema drift

Options:
  --env <path>            Load PAT and IDs from an env file (default: .env.local, .env)
  --manifest <path>       Manifest path (default: notion.schema.json)
  --out <path>            Generated TypeScript path (default: src/notion.generated.ts)
  --id <id-or-url>        Data source ID, database ID, or Notion database URL
  --name <exportName>     Generated schema export name
  --sync-key <name>       Stable rich-text key (default: Client ID)
  --dry-run               Show what push would change without updating Notion
  --accept-data-loss      Permit type changes or option removal during push
  --help, -h              Show help
  --version, -v           Show the installed package version

Environment:
  NOTION_PAT (preferred) or NOTION_TOKEN
  NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID
`

function parseArgs(argv: Array<string>): CliOptions {
  const base = (command: Command): CliOptions => ({
    command,
    manifestPath: resolve('notion.schema.json'),
    dryRun: false,
    allowDestructive: false,
    deprecatedAllowDestructive: false,
  })
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return base('help')
  }
  if (argv[0] === '--version' || argv[0] === '-v') return base('version')
  const command = argv[0]
  if (
    command !== 'init' &&
    command !== 'pull' &&
    command !== 'generate' &&
    command !== 'check' &&
    command !== 'push' &&
    command !== 'doctor'
  ) {
    throw new Error(help)
  }
  if (argv.includes('--help') || argv.includes('-h')) return base('help')
  if (argv.includes('--version') || argv.includes('-v')) return base('version')
  const values = new Map<string, string>()
  let dryRun = false
  let allowDestructive = false
  let deprecatedAllowDestructive = false
  const valuedOptions = new Set([
    '--env',
    '--manifest',
    '--out',
    '--id',
    '--name',
    '--sync-key',
  ])
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (
      argument === '--accept-data-loss' ||
      argument === '--allow-destructive'
    ) {
      allowDestructive = true
      if (argument === '--allow-destructive') deprecatedAllowDestructive = true
      continue
    }
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}\n\n${help}`)
    }
    if (!valuedOptions.has(argument)) {
      throw new Error(`Unknown option: ${argument}\n\n${help}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}.`)
    }
    values.set(argument, value)
    index += 1
  }
  return {
    command,
    manifestPath: resolve(values.get('--manifest') ?? 'notion.schema.json'),
    dryRun,
    allowDestructive,
    deprecatedAllowDestructive,
    ...(values.has('--env') ? { envFile: resolve(values.get('--env')!) } : {}),
    ...(values.has('--out')
      ? { outputPath: resolve(values.get('--out')!) }
      : {}),
    ...(values.has('--id') ? { id: values.get('--id')! } : {}),
    ...(values.has('--name')
      ? { exportName: values.get('--name')! }
      : {}),
    ...(values.has('--sync-key')
      ? { syncKeyName: values.get('--sync-key')! }
      : {}),
  }
}

async function readManifest(path: string): Promise<NotionSchemaManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  try {
    assertNotionSchemaManifest(value)
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : 'Invalid manifest.'}`,
    )
  }
  return value
}

function notionSourceUrl(dataSourceId: string): string {
  return `https://www.notion.so/${dataSourceId.replaceAll('-', '')}`
}

async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown }
  return typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
}

async function writeGenerated(
  manifest: NotionSchemaManifest,
  manifestPath: string,
  outputPath?: string,
): Promise<string> {
  const destination = outputPath ?? defaultGeneratedPath(manifestPath)
  await mkdir(dirname(destination), { recursive: true })
  await atomicWriteFile(destination, generateNotionSchemaSource(manifest))
  return destination
}

async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function writeManifest(
  path: string,
  manifest: NotionSchemaManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await atomicWriteFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

interface CliCredentials {
  token: string
  id: string
  promptedToken: boolean
  promptedId: boolean
}

async function resolveCredentials(
  options: CliOptions,
  manifest?: NotionSchemaManifest,
): Promise<CliCredentials> {
  let token = process.env.NOTION_PAT ?? process.env.NOTION_TOKEN
  let id =
    options.id ??
    process.env.NOTION_DATA_SOURCE_ID ??
    process.env.NOTION_DATABASE_ID ??
    manifest?.dataSourceId
  let promptedToken = false
  let promptedId = false

  if (
    (!token || !id) &&
    options.command === 'init' &&
    stdin.isTTY &&
    stdout.isTTY
  ) {
    const prompt = createInterface({ input: stdin, output: stdout })
    try {
      if (!token) {
        stdout.write('Notion PAT (saved to .env.local): ')
        stdout.write('\u001B[8m')
        try {
          token = (await prompt.question('')).trim()
        } finally {
          stdout.write('\u001B[28m\n')
        }
        promptedToken = true
      }
      if (!id) {
        id = (await prompt.question('Notion database URL or ID: ')).trim()
        promptedId = true
      }
    } finally {
      prompt.close()
    }
  }

  if (!token) {
    throw new Error('Set NOTION_PAT (or NOTION_TOKEN) before calling Notion.')
  }
  if (!id) {
    throw new Error(
      'Set NOTION_DATA_SOURCE_ID or NOTION_DATABASE_ID, or run init in an interactive terminal.',
    )
  }
  return { token, id, promptedToken, promptedId }
}

async function savePromptedCredentials(
  options: CliOptions,
  auth: CliCredentials,
  dataSourceId: string,
): Promise<void> {
  if (!auth.promptedToken && !auth.promptedId) return
  const path = options.envFile ?? resolve('.env.local')
  await updateEnvFile(path, {
    ...(auth.promptedToken ? { NOTION_PAT: auth.token } : {}),
    NOTION_DATA_SOURCE_ID: dataSourceId,
  })
  if (!options.envFile) await ignoreDefaultEnvFile(path)
  console.log(`Saved server credentials to ${path}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'help') {
    console.log(help)
    return
  }
  if (options.command === 'version') {
    console.log(await packageVersion())
    return
  }
  if (options.deprecatedAllowDestructive) {
    console.warn(
      '--allow-destructive is deprecated; use --accept-data-loss after reviewing the dry run.',
    )
  }
  if (options.dryRun && options.command !== 'push') {
    throw new Error('--dry-run is only valid with the push command.')
  }
  if (options.command === 'generate') {
    const manifest = await readManifest(options.manifestPath)
    const output = await writeGenerated(
      manifest,
      options.manifestPath,
      options.outputPath,
    )
    console.log(`Generated ${output}`)
    return
  }

  loadCliEnvironment(options.envFile)

  const existing = existsSync(options.manifestPath)
    ? await readManifest(options.manifestPath)
    : undefined
  const auth = await resolveCredentials(options, existing)
  const snapshot = await inspectNotionDataSource(auth)

  if (options.command === 'init') {
    await savePromptedCredentials(options, auth, snapshot.dataSourceId)
  }

  if (options.command === 'doctor') {
    console.log(`Connected to ${snapshot.name ?? 'unnamed data source'}.`)
    console.log(`Data source: ${snapshot.dataSourceId}`)
    console.log(`Notion: ${notionSourceUrl(snapshot.dataSourceId)}`)
    console.log(`Properties: ${snapshot.properties.length}`)
    if (existing) {
      const operations = diffNotionSchema(existing, snapshot)
      console.log(formatNotionSchemaDrift(operations))
      if (operations.length) process.exitCode = 1
    } else {
      console.log(`Manifest not found: ${options.manifestPath}`)
    }
    return
  }

  if (options.command === 'init' || options.command === 'pull') {
    const manifest = createNotionSchemaManifest(snapshot, {
      ...(existing ? { existing } : {}),
      ...(options.exportName ? { exportName: options.exportName } : {}),
      ...(options.syncKeyName ? { syncKeyName: options.syncKeyName } : {}),
    })
    await writeManifest(options.manifestPath, manifest)
    const output = await writeGenerated(
      manifest,
      options.manifestPath,
      options.outputPath,
    )
    console.log(
      `Pulled ${snapshot.properties.length} properties into ${options.manifestPath}`,
    )
    console.log(`Generated ${output}`)
    console.log(`Notion: ${notionSourceUrl(snapshot.dataSourceId)}`)
    return
  }

  if (!existing) {
    throw new Error(
      `Missing ${options.manifestPath}. Run the init command first.`,
    )
  }
  const operations = diffNotionSchema(existing, snapshot)
  if (options.command === 'check') {
    console.log(formatNotionSchemaDrift(operations))
    console.log(`Notion: ${notionSourceUrl(snapshot.dataSourceId)}`)
    if (operations.length) process.exitCode = 1
    return
  }
  console.log(formatNotionSchemaDiff(operations))
  console.log(`Notion: ${notionSourceUrl(snapshot.dataSourceId)}`)
  if (
    operations.some(
      (operation) =>
        operation.kind === 'add' &&
        operation.field.key === existing.syncKey.key,
    )
  ) {
    console.warn(
      `Note: push will add the visible ${JSON.stringify(existing.syncKey.name)} rich-text property used as the stable offline sync key.`,
    )
  }
  if (options.dryRun) return

  const updatedSnapshot = await pushNotionSchema({
    ...auth,
    manifest: existing,
    snapshot,
    acceptDataLoss: options.allowDestructive,
  })
  const updatedManifest = createNotionSchemaManifest(updatedSnapshot, {
    existing,
  })
  await writeManifest(options.manifestPath, updatedManifest)
  const output = await writeGenerated(
    updatedManifest,
    options.manifestPath,
    options.outputPath,
  )
  console.log(`Applied ${operations.length} schema operation(s).`)
  console.log(`Updated ${options.manifestPath}`)
  console.log(`Generated ${output}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
