import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { importSources } from '../src/public/index.ts'
import type { JsonValue } from '../src/public/index.ts'

const sourceRoot = new URL('../../../fixtures/source/', import.meta.url)

interface FixtureSpec {
  path: string
  candidates: number
  statuses: Record<string, number>
  diagnostics: Record<string, number>
}

async function fixtureSpecs(): Promise<{ totalCandidates: number; byPath: Map<string, FixtureSpec> }> {
  const text = await readFile(new URL('../../../fixtures/phase-07-b/manifest.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(text) as { version: number; totalCandidates: number; fixtures: FixtureSpec[] }
  assert.equal(manifest.version, 1)
  return { totalCandidates: manifest.totalCandidates, byPath: new Map(manifest.fixtures.map((fixture) => [fixture.path, fixture])) }
}

async function fixtureFiles(): Promise<Array<{ relative: string; path: string }>> {
  const result: Array<{ relative: string; path: string }> = []
  for (const group of ['collection', 'single']) {
    const directory = new URL(`${group}/`, sourceRoot)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      result.push({ relative: `${group}/${entry.name}`, path: fileURLToPath(new URL(entry.name, directory)) })
    }
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative))
}

function counts(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => { result[value] = (result[value] ?? 0) + 1; return result }, {})
}

function statuses(candidates: Awaited<ReturnType<typeof importSources>>): Record<string, number> {
  return counts(candidates.map((candidate) => candidate.status))
}

function diagnostics(candidates: Awaited<ReturnType<typeof importSources>>): Record<string, number> {
  return counts(candidates.flatMap((candidate) => candidate.diagnostics.map((item) => item.code)))
}

test('07-B discovers the complete source fixture corpus', async () => {
  const specification = await fixtureSpecs()
  const files = await fixtureFiles()
  assert.deepEqual(files.map((file) => file.relative), [...specification.byPath.keys()].sort())
  assert.equal(files.reduce((total, file) => total + (specification.byPath.get(file.relative)?.candidates ?? 0), 0), specification.totalCandidates)
})

test('07-B raw text, parsed value and controlled file reader have identical source results', async () => {
  const specification = await fixtureSpecs()
  const files = await fixtureFiles()
  const readerCalls: string[] = []
  for (const file of files) {
    const fixture = specification.byPath.get(file.relative)!
    const text = await readFile(file.path, 'utf8')
    const parsed = JSON.parse(text) as JsonValue
    assert.ok(Array.isArray(parsed), file.relative)

    const fromText = await importSources(text)
    const fromValue = await importSources(parsed)
    const fromFile = await importSources({ kind: 'file', uri: file.path }, {
      reader: {
        async read(request) {
          readerCalls.push(request.uri)
          return { text: await readFile(request.uri, 'utf8'), location: request.uri }
        },
      },
    })

    assert.equal(fromText.length, fixture.candidates, file.relative)
    assert.deepEqual(statuses(fromText), fixture.statuses, file.relative)
    assert.deepEqual(diagnostics(fromText), fixture.diagnostics, `${file.relative}: diagnostics`)
    assert.deepEqual(statuses(fromValue), statuses(fromText), `${file.relative}: parsed value`)
    assert.deepEqual(statuses(fromFile), statuses(fromText), `${file.relative}: file reader`)
    assert.deepEqual(fromValue.map((candidate) => candidate.source?.bookSourceUrl), fromText.map((candidate) => candidate.source?.bookSourceUrl), `${file.relative}: source ids`)
    assert.deepEqual(fromFile.map((candidate) => candidate.source?.bookSourceUrl), fromText.map((candidate) => candidate.source?.bookSourceUrl), `${file.relative}: file source ids`)
    assert.deepEqual(fromValue.map((candidate) => candidate.unknownFields), fromText.map((candidate) => candidate.unknownFields), `${file.relative}: unknown fields`)
    assert.deepEqual(fromValue.map((candidate) => candidate.raw.fieldShapes), fromText.map((candidate) => candidate.raw.fieldShapes), `${file.relative}: rule shapes`)
  }
  assert.deepEqual(readerCalls, files.map((file) => file.path))
})

test('07-B a collection member follows the same single-source entry', async () => {
  const collectionPath = fileURLToPath(new URL('collection/13655_c5880332228edeffa2ce977a525a6b21.json', sourceRoot))
  const collectionText = await readFile(collectionPath, 'utf8')
  const members = JSON.parse(collectionText) as JsonValue[]
  const collection = await importSources(collectionText)
  const single = await importSources(JSON.stringify(members[0]))
  assert.equal(collection[0]?.status, single[0]?.status)
  assert.deepEqual(collection[0]?.source, single[0]?.source)
  assert.deepEqual(collection[0]?.diagnostics, single[0]?.diagnostics)
})

test('07-B fixture import keeps candidate, byte and cancellation limits isolated', async () => {
  const file = fileURLToPath(new URL('collection/13655_c5880332228edeffa2ce977a525a6b21.json', sourceRoot))
  const text = await readFile(file, 'utf8')
  const limited = await importSources(text, { limits: { maxCandidates: 3 } })
  assert.equal(limited.length, 3)
  assert.ok(limited.every((candidate) => candidate.status === 'ready'))

  const tooLarge = await importSources(text, { limits: { maxBytes: 1 } })
  assert.equal(tooLarge[0]?.error?.code, 'response-too-large')

  const controller = new AbortController()
  controller.abort()
  const cancelled = await importSources(text, { signal: controller.signal })
  assert.equal(cancelled[0]?.error?.code, 'cancelled')
})
