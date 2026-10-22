import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStaticCompatibilityReport, classifyKnownBrokenRules, loadKnownBrokenRules, loadSourceFixtureCandidates } from '../src/source-compatibility.ts'

test('静态语料审计只把 manifest 登记的坏规则归为已知', async () => {
  const candidates = await loadSourceFixtureCandidates()
  const report = classifyKnownBrokenRules(buildStaticCompatibilityReport(candidates), await loadKnownBrokenRules())
  assert.equal(report.summary.candidates, 943)
  assert.equal(report.summary.rules, 20_231)
  assert.equal(report.summary.compiledRules, 20_226)
  assert.equal(report.summary.uncompiledRules, 5)
  assert.equal(report.summary.knownUncompiledRules, 5)
  assert.equal(report.summary.unexpectedUncompiledRules, 0)
  assert.equal(report.summary.staleKnownBrokenRules, 0)
  assert.ok(report.knownBrokenRules.every((rule) => rule.status === 'matched'))
})
