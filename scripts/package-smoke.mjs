import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const projectRoot = resolve(import.meta.dirname, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'notion-adapter-package-smoke-'))

async function run(command, args, cwd = temporaryRoot) {
  try {
    return await exec(command, args, {
      cwd,
      encoding: 'utf8',
      env:
        command === 'npm'
          ? { ...process.env, npm_config_dry_run: 'false' }
          : process.env,
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (error) {
    if (error && typeof error === 'object') {
      process.stderr.write(error.stdout ?? '')
      process.stderr.write(error.stderr ?? '')
    }
    throw error
  }
}

function countDependency(node, name) {
  if (!node?.dependencies) return 0
  return Object.entries(node.dependencies).reduce(
    (count, [dependencyName, dependency]) =>
      count +
      (dependencyName === name ? 1 : 0) +
      countDependency(dependency, name),
    0,
  )
}

try {
  const { stdout } = await run(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryRoot],
    projectRoot,
  )
  const [packResult] = JSON.parse(stdout)
  if (!packResult?.filename) throw new Error('npm pack did not return a filename.')
  const tarball = join(temporaryRoot, basename(packResult.filename))

  await writeFile(
    join(temporaryRoot, 'package.json'),
    JSON.stringify({ name: 'adapter-package-smoke', private: true, type: 'module' }),
  )
  await run('npm', [
    'install',
    '--ignore-scripts',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    tarball,
    'react@^19',
  ])

  await writeFile(
    join(temporaryRoot, 'consumer.mjs'),
    `import { notion, notionCollectionOptions } from 'tanstack-db-notion-adapter'
import { createNotionSyncHandler } from 'tanstack-db-notion-adapter/server'
import { generateNotionSchemaSource } from 'tanstack-db-notion-adapter/schema-tools'
import { useNotionPageContent, useNotionSyncState } from 'tanstack-db-notion-adapter/react'

for (const [name, value] of Object.entries({ notion, notionCollectionOptions, createNotionSyncHandler, generateNotionSchemaSource, useNotionPageContent, useNotionSyncState })) {
  if (typeof value !== (name === 'notion' ? 'object' : 'function')) {
    throw new Error(\`Missing public export: \${name}\`)
  }
}
`,
  )
  await run('node', ['consumer.mjs'])

  const { stdout: dependencyTree } = await run('npm', [
    'ls',
    '@tanstack/db',
    '--all',
    '--json',
  ])
  if (countDependency(JSON.parse(dependencyTree), '@tanstack/db') !== 1) {
    throw new Error('The packed package installed more than one @tanstack/db runtime.')
  }

  const cli = join(temporaryRoot, 'node_modules', '.bin', 'tanstack-db-notion')
  const { stdout: cliHelp } = await run(cli, ['--help'])
  if (
    !cliHelp.includes('push       Update Notion') ||
    !cliHelp.includes('default: src/notion.generated.ts')
  ) {
    throw new Error('Packed CLI did not print help.')
  }
  const { stdout: cliVersion } = await run(cli, ['--version'])
  if (!/^\d+\.\d+\.\d+/.test(cliVersion.trim())) {
    throw new Error('Packed CLI did not print a semantic version.')
  }
  const manifestSchema = JSON.parse(
    await readFile(
      join(
        temporaryRoot,
        'node_modules',
        'tanstack-db-notion-adapter',
        'schema',
        'notion.schema.json',
      ),
      'utf8',
    ),
  )
  if (manifestSchema.title !== 'TanStack DB Notion schema manifest') {
    throw new Error('Packed manifest JSON Schema is missing.')
  }
  for (const file of [
    'frameworks.md',
    'page-content.md',
    'sqlite-idempotency-store.ts',
  ]) {
    await access(
      join(
        temporaryRoot,
        'node_modules',
        'tanstack-db-notion-adapter',
        'docs',
        file,
      ),
    )
  }
  try {
    await access(
      join(
        temporaryRoot,
        'node_modules',
        'tanstack-db-notion-adapter',
        'docs',
        'SHIP_READINESS.md',
      ),
    )
    throw new Error('The packed package contains the internal ship-readiness backlog.')
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }

  await writeFile(
    join(temporaryRoot, 'browser-entry.js'),
    `import { notion, notionCollectionOptions } from 'tanstack-db-notion-adapter'
globalThis.__adapter = { notion, notionCollectionOptions }
`,
  )
  const esbuild = join(projectRoot, 'node_modules', '.bin', 'esbuild')
  await run(esbuild, [
    'browser-entry.js',
    '--bundle',
    '--platform=browser',
    '--format=esm',
    '--outfile=browser-bundle.js',
  ])
  const browserBundle = await readFile(
    join(temporaryRoot, 'browser-bundle.js'),
    'utf8',
  )
  for (const forbidden of [
    'createNotionSyncHandler',
    'Authorization: `Bearer',
    'A Notion token is required',
  ]) {
    if (browserBundle.includes(forbidden)) {
      throw new Error(`The browser bundle contains server-only code: ${forbidden}`)
    }
  }

  process.stdout.write('Packed consumer imports and browser isolation passed.\n')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
