import { createHash } from 'node:crypto'
import type { NormalizedSource } from '@legado/source-core'
import type { ReaderRepository } from './repository.ts'

let loaded = false

export async function seedConfiguredSources(repository: ReaderRepository): Promise<void> {
  if (loaded) return
  const raw = process.env.READER_SOURCES_JSON?.trim() ?? ''
  if (raw.length === 0) { loaded = true; return }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('READER_SOURCES_JSON 不是有效 JSON') }
  if (!Array.isArray(parsed)) throw new Error('READER_SOURCES_JSON 必须是书源数组')
  const records = parsed.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const source = item as Record<string, unknown>
    if (typeof source.bookSourceUrl !== 'string' || source.bookSourceUrl.trim().length === 0 || typeof source.bookSourceName !== 'string') return []
    const normalizedSource = source as unknown as NormalizedSource
    return [{ sourceId: normalizedSource.bookSourceUrl, fingerprint: fingerprint(normalizedSource), rawSource: item, normalizedSource }]
  })
  if (records.length !== parsed.length) throw new Error('READER_SOURCES_JSON 包含无效书源')
  await repository.upsertSources(records)
  loaded = true
}

export function resetSourceSeedForTests(): void { loaded = false }
function fingerprint(source: NormalizedSource): string { return createHash('sha256').update(JSON.stringify(source)).digest('hex') }
