import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { mergeSearchStreamCandidates, searchProgressFromEvent } from '../src/lib/api.ts'
import type { ApiCandidate } from '../src/lib/api.ts'

const code = ts.transpileModule(readFileSync(new URL('../src/lib/use-book-search.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

test('targeted searches retain other versions and each candidate keeps its original search ID', async () => {
  const states: unknown[] = []
  const refs: { current: unknown }[] = []
  let stateIndex = 0
  let refIndex = 0
  let initialized = false
  let searchNumber = 0
  let results: ApiCandidate[] = []
  const candidate = (sourceId: string, duration: number): ApiCandidate => ({ sourceId, sourceFingerprint: sourceId, searchDurationMs: duration, candidate: { sourceId, bookUrl: sourceId + '/book', name: '目标书' } })
  const module = { exports: {} as { useBookSearch: () => { candidates: ApiCandidate[]; candidateSearchId: (candidate: ApiCandidate) => string; search: (keyword: string, precision: boolean) => Promise<boolean>; replaceSearch: (keyword: string, precision: boolean, sources: string[], preserve: boolean) => Promise<boolean> } } }
  class SearchOperation {
    isRunning = false
    hasPendingCancellation = false
    async cancel() {}
    async start(_keyword: string, _precision: boolean, event: (event: unknown) => void, created: (id: string) => void) {
      const id = 'search-' + ++searchNumber
      created(id)
      event({ type: 'batch', data: { candidates: results } })
      return { id, cancelled: false }
    }
  }
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => {
    if (name === 'react') return {
      useState(initial: unknown) { const index = stateIndex++; if (!initialized) states[index] = initial; return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next }] },
      useRef(initial: unknown) { const index = refIndex++; refs[index] ??= { current: initial }; return refs[index] },
      useMemo: (create: () => unknown) => create(),
      useEffect: (effect: () => void) => { effect() },
    }
    if (name.includes('use-page-resource')) return { usePageNavigation: () => undefined }
    if (name.includes('search-operation')) return { SearchOperation }
    if (name.includes('page-data')) return { publishPageMutation() {} }
    if (name.includes('api')) return { mergeSearchStreamCandidates, searchProgressFromEvent }
    return {}
  } })
  function render() { stateIndex = 0; refIndex = 0; const hook = module.exports.useBookSearch(); initialized = true; return hook }
  let hook = render()
  results = [candidate('https://a.example', 100)]
  assert.equal(await hook.search('目标书', true), true)
  hook = render()
  results = [candidate('https://b.example', 50)]
  assert.equal(await hook.replaceSearch('目标书', true, ['https://b.example'], true), true)
  hook = render()
  assert.equal(hook.candidates.length, 2)
  assert.equal(hook.candidateSearchId(hook.candidates[0]!), 'search-1')
  assert.equal(hook.candidateSearchId(hook.candidates[1]!), 'search-2')
  results = [candidate('https://b.example', 20)]
  await hook.replaceSearch('目标书', true, ['https://b.example'], true)
  hook = render()
  assert.equal(hook.candidates.length, 2)
  assert.equal(hook.candidates[1]?.searchDurationMs, 20)
  assert.equal(hook.candidateSearchId(hook.candidates[1]!), 'search-3')
  results = []
  await hook.replaceSearch('目标书', true, ['https://b.example'], true)
  hook = render()
  assert.equal(hook.candidates.length, 1)
  assert.equal(hook.candidateSearchId(hook.candidates[0]!), 'search-1')
})
