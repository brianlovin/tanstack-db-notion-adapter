import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export function defaultGeneratedPath(manifestPath: string): string {
  const directory = dirname(manifestPath)
  const destination = resolve(directory, 'notion.generated.ts')
  const legacyDestination = resolve(directory, 'src/notion.generated.ts')
  return !existsSync(destination) && existsSync(legacyDestination)
    ? legacyDestination
    : destination
}

export function loadCliEnvironment(
  explicitPath?: string,
  cwd = process.cwd(),
): void {
  if (explicitPath) {
    process.loadEnvFile(explicitPath)
    return
  }
  for (const name of ['.env.local', '.env']) {
    const path = resolve(cwd, name)
    if (existsSync(path)) process.loadEnvFile(path)
  }
}

function envLine(name: string, value: string): string {
  return `${name}=${JSON.stringify(value)}`
}

export async function updateEnvFile(
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const existing = existsSync(path) ? await readFile(path, 'utf8') : ''
  const lines = existing ? existing.replace(/\n$/, '').split('\n') : []
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((line) =>
      new RegExp(`^\\s*${name}\\s*=`).test(line),
    )
    if (index === -1) lines.push(envLine(name, value))
    else lines[index] = envLine(name, value)
  }
  await writeFile(path, `${lines.join('\n')}\n`, { mode: 0o600 })
}

export async function saveInitEnvironment(
  path: string,
  values: { dataSourceId: string; promptedToken?: string },
): Promise<void> {
  await updateEnvFile(path, {
    ...(values.promptedToken ? { NOTION_PAT: values.promptedToken } : {}),
    NOTION_DATA_SOURCE_ID: values.dataSourceId,
  })
}

export async function ignoreDefaultEnvFile(path: string): Promise<void> {
  if (basename(path) !== '.env.local') return
  const gitignorePath = resolve(dirname(path), '.gitignore')
  const existing = existsSync(gitignorePath)
    ? await readFile(gitignorePath, 'utf8')
    : ''
  if (existing.split(/\r?\n/).includes('.env.local')) return
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await writeFile(gitignorePath, `${existing}${separator}.env.local\n`)
}
