import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface FileEnvelope<T> {
  schemaVersion: 1
  revision: number
  updatedAt: string
  data: T
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvelope(value: unknown): value is FileEnvelope<unknown> {
  return isObject(value) && value.schemaVersion === 1 && typeof value.revision === 'number' && typeof value.updatedAt === 'string' && 'data' in value
}

function isUnsupportedEnvelope(value: unknown): boolean {
  return isObject(value) && typeof value.schemaVersion === 'number' && value.schemaVersion !== 1 && 'data' in value
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export class JsonStore {
  private readonly now: () => Date

  public constructor(now: () => Date) {
    this.now = now
  }

  public async readOptional<T>(path: string): Promise<T | undefined> {
    try {
      return await this.readFile<T>(path, undefined)
    } catch (error) {
      if (error instanceof Error && ['missing-file', 'corrupt-file', 'unsupported-schema'].includes(error.message)) return undefined
      throw error
    }
  }

  public async readFile<T>(path: string, fallback: T | undefined): Promise<T> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('missing-file')
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      const backup = `${path}.corrupt-${this.now().toISOString().replaceAll(':', '')}.json`
      await rename(path, backup)
      if (fallback !== undefined) {
        await this.writeFile(path, fallback)
        return fallback
      }
      throw new Error('corrupt-file')
    }
    if (isEnvelope(parsed)) return parsed.data as T
    if (isUnsupportedEnvelope(parsed)) {
      const backup = `${path}.unsupported-${this.now().toISOString().replaceAll(':', '')}.json`
      await rename(path, backup)
      if (fallback !== undefined) {
        await this.writeFile(path, fallback)
        return fallback
      }
      throw new Error('unsupported-schema')
    }
    return parsed as T
  }

  public async writeFile<T>(path: string, value: T): Promise<void> {
    await ensureDirectory(dirname(path))
    const existing = await this.readEnvelopeRevision(path)
    const envelope: FileEnvelope<T> = { schemaVersion: 1, revision: existing + 1, updatedAt: this.now().toISOString(), data: value }
    const temporary = join(dirname(path), `.${basename(path) || 'state'}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 })
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  }

  private async readEnvelopeRevision(path: string): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      return isEnvelope(parsed) ? parsed.revision : 0
    } catch {
      return 0
    }
  }
}
