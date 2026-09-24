import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileRule, importSources } from '../src/index.ts'
import type { JsonValue } from '../src/index.ts'

const sourceRoot = new URL('../../../fixtures/source/', import.meta.url)

interface FixtureSpec {
  path: string
  candidates: number
  statuses: Record<string, number>
  diagnostics: Record<string, number>
}

const ruleGroups = ['ruleExplore', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview'] as const

interface BrokenRuleSpec {
  path: string
  sourceName: string
  group: string
  field: string
  code: string
  ruleHash: string
}

/** 与 fixtures/corpus/regenerate.mjs 保持一致：白名单条目绑定规则原文。 */
function ruleFingerprint(rule: string): string {
  return createHash('sha256').update(rule).digest('hex').slice(0, 16)
}

async function fixtureSpecs(): Promise<{ totalCandidates: number; byPath: Map<string, FixtureSpec>; brokenRules: Map<string, BrokenRuleSpec> }> {
  const text = await readFile(new URL('../../../fixtures/corpus/manifest.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(text) as { version: number; totalCandidates: number; fixtures: FixtureSpec[]; knownBrokenRules: BrokenRuleSpec[] }
  assert.equal(manifest.version, 2)
  return {
    totalCandidates: manifest.totalCandidates,
    byPath: new Map(manifest.fixtures.map((fixture) => [fixture.path, fixture])),
    // 真实语料里已知的坏规则白名单：只有它们允许编译失败，新出现的失败仍会让测试红。
    brokenRules: new Map(manifest.knownBrokenRules.map((entry) => [`${entry.path}\u0000${entry.sourceName}\u0000${entry.group}.${entry.field}`, entry])),
  }
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

test('发现完整的真实书源语料', async () => {
  const specification = await fixtureSpecs()
  const files = await fixtureFiles()
  assert.deepEqual(files.map((file) => file.relative), [...specification.byPath.keys()].sort())
  assert.equal(files.reduce((total, file) => total + (specification.byPath.get(file.relative)?.candidates ?? 0), 0), specification.totalCandidates)
})

test('原始文本、解析值与受控文件读取器导入结果一致', async () => {
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

async function largestCollectionFile(): Promise<{ relative: string; path: string }> {
  const files = (await fixtureFiles()).filter((file) => file.relative.startsWith('collection/'))
  assert.ok(files.length > 0, '语料中至少需要一个 collection 文件')
  let best = files[0]!
  let bestCount = -1
  for (const file of files) {
    const members = JSON.parse(await readFile(file.path, 'utf8')) as unknown
    const count = Array.isArray(members) ? members.length : 1
    if (count > bestCount) {
      best = file
      bestCount = count
    }
  }
  assert.ok(bestCount >= 4, '需要至少含 4 个成员的集合文件以覆盖导入限额')
  return best
}

test('集合成员与单个导入路径一致', async () => {
  const collectionPath = (await largestCollectionFile()).path
  const collectionText = await readFile(collectionPath, 'utf8')
  const members = JSON.parse(collectionText) as JsonValue[]
  assert.ok(Array.isArray(members) && members.length > 0)
  const collection = await importSources(collectionText)
  const single = await importSources(JSON.stringify(members[0]))
  assert.equal(collection[0]?.status, single[0]?.status)
  assert.deepEqual(collection[0]?.source, single[0]?.source)
  assert.deepEqual(collection[0]?.diagnostics, single[0]?.diagnostics)
})

test('真实书源即使可选流程不完整也能结构解析', async () => {
  const specification = await fixtureSpecs()
  const files = await fixtureFiles()
  const usedBroken = new Set<string>()
  let ruleCount = 0
  for (const file of files) {
    const candidates = await importSources(await readFile(file.path, 'utf8'))
    assert.ok(candidates.every((candidate) => candidate.status === 'ready'), `${file.relative}: every source must be importable`)
    for (const candidate of candidates) {
      const source = candidate.source
      assert.ok(source, `${file.relative}: source missing after import`)
      for (const group of ruleGroups) {
        const value: JsonValue | undefined = source[group]
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
        for (const [field, rule] of Object.entries(value)) {
          if (typeof rule !== 'string' || rule.length === 0) continue
          ruleCount += 1
          const key: string = `${file.relative}:${source.bookSourceName}:${group}.${field}`
          const compiled = compileRule(rule)
          const known = specification.brokenRules.get(`${file.relative}\u0000${source.bookSourceName}\u0000${group}.${field}`)
          if (known === undefined) {
            assert.deepEqual(compiled.diagnostics, [], key)
            assert.ok(compiled.rule, key)
            continue
          }
          // 已登记的真实坏规则：诊断与指纹都必须与 manifest 一致，且这条规则确实编译不出来。
          usedBroken.add(`${file.relative}\u0000${source.bookSourceName}\u0000${group}.${field}`)
          assert.deepEqual(compiled.diagnostics.map((item) => item.code), [known.code], key)
          assert.equal(compiled.rule, undefined, key)
          assert.equal(ruleFingerprint(rule), known.ruleHash, `${key} 的坏规则白名单已过期，请重新生成 manifest`)
        }
      }
    }
  }
  assert.ok(ruleCount > 0)
  // 白名单不能有残留：语料里已经修好或删掉的条目必须一并清理。
  assert.deepEqual([...specification.brokenRules.keys()].filter((key) => !usedBroken.has(key)), [])
})

test('导入限额隔离候选数、字节数与取消', async () => {
  const file = (await largestCollectionFile()).path
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
