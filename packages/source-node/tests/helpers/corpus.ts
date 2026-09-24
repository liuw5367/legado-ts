import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ImportCandidate, NormalizedSource } from '../../../source-core/src/index.ts'
import { loadSourceFixtureCandidates } from '../../src/index.ts'

/** fixtures/source 语料根目录；禁止在测试中写死具体 *.json 文件名。 */
export const sourceRoot = new URL('../../../../fixtures/source/', import.meta.url)

export interface FixtureFile {
  readonly relative: string
  readonly path: string
}

/** 遍历 collection/ 与 single/ 下全部 JSON 文件。 */
export async function listFixtureFiles(root = sourceRoot): Promise<FixtureFile[]> {
  const result: FixtureFile[] = []
  for (const group of ['collection', 'single'] as const) {
    const directory = new URL(`${group}/`, root)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      result.push({ relative: `${group}/${entry.name}`, path: fileURLToPath(new URL(entry.name, directory)) })
    }
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative))
}

export async function loadFixtureCandidates(): Promise<ImportCandidate[]> {
  const items = await loadSourceFixtureCandidates()
  return items.map((item) => item.candidate)
}

export async function loadFixtureSources(): Promise<NormalizedSource[]> {
  const candidates = await loadFixtureCandidates()
  return candidates.flatMap((candidate) => candidate.source === undefined ? [] : [candidate.source])
}

export async function readFixtureFile(file: FixtureFile): Promise<string> {
  return readFile(file.path, 'utf8')
}
