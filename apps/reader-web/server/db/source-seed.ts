import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importSources, sourceDefinitionFingerprint } from '@legado/source-core'
import type { NormalizedSource } from '@legado/source-core'
import { readSourcePath } from '@legado/source-node'
import type { ReaderRepository } from './repository.ts'

let loaded = false
let loading: Promise<void> | undefined

export async function seedConfiguredSources(repository: ReaderRepository): Promise<void> {
  if (loaded) return
  if (loading !== undefined) return loading
  const current = loadConfiguredSources(repository)
  loading = current
  try {
    await current
    loaded = true
  } finally {
    if (loading === current) loading = undefined
  }
}

async function loadConfiguredSources(repository: ReaderRepository): Promise<void> {
  const directory = configuredSourceDirectory()
  const loadedFiles = await readSourcePath(directory)
  for (const diagnostic of loadedFiles.diagnostics) console.warn(`[reader-web] ${diagnostic}`)
  const bySourceId = new Map<string, SourceRecord>()
  const fingerprints = new Map<string, Set<string>>()
  for (const input of loadedFiles.inputs) {
    const candidates = await importSources({ kind: 'text', text: input.text, origin: { kind: 'file', location: input.location } }, { limits: { maxCandidates: 1000, maxBytes: 4 * 1024 * 1024 } })
    for (const candidate of candidates) {
      const source = candidate.source
      if (source === undefined) {
        if (candidate.error !== undefined) console.warn(`[reader-web] ${input.location}: ${candidate.error.message}`)
        continue
      }
      const fingerprint = candidate.sourceFingerprint ?? sourceDefinitionFingerprint(source)
      const values = fingerprints.get(source.bookSourceUrl) ?? new Set<string>()
      values.add(fingerprint)
      fingerprints.set(source.bookSourceUrl, values)
      bySourceId.set(source.bookSourceUrl, {
        sourceId: source.bookSourceUrl,
        fingerprint,
        rawSource: candidate.raw.parsed ?? source,
        normalizedSource: source,
        enabled: source.bookSourceType === 0 && source.enabled !== false,
        customOrder: integerField(source.customOrder, 0),
      })
    }
  }
  const conflicts = new Set([...fingerprints].filter(([, values]) => values.size > 1).map(([sourceId]) => sourceId))
  for (const sourceId of conflicts) console.warn(`[reader-web] 跳过冲突书源：${sourceId}`)
  await repository.upsertSources([...bySourceId.values()].filter((record) => !conflicts.has(record.sourceId)))
}

export function resetSourceSeedForTests(): void { loaded = false }

interface SourceRecord {
  sourceId: string
  fingerprint: string
  rawSource: unknown
  normalizedSource: NormalizedSource
  enabled: boolean
  customOrder: number
}

function configuredSourceDirectory(): string {
  const configured = process.env.READER_SOURCES_DIR?.trim()
  if (configured !== undefined && configured.length > 0) return resolve(configured)
  const workingDirectory = resolve(process.cwd(), 'fixtures/source')
  if (existsSync(workingDirectory)) return workingDirectory
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/source')
}

function integerField(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback }
