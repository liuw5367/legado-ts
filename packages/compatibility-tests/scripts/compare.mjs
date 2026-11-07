import { stable, validateResult } from './common.mjs'

export function differences(jvm, ts, path = '$') {
  if (Object.is(jvm, ts)) return []
  if (Array.isArray(jvm) && Array.isArray(ts)) {
    const result = []
    for (let i = 0; i < Math.max(jvm.length, ts.length); i++) {
      if (i >= jvm.length || i >= ts.length) result.push({ path: `${path}/${i}`, jvm: i < jvm.length ? jvm[i] : { type: 'missing' }, ts: i < ts.length ? ts[i] : { type: 'missing' } })
      else result.push(...differences(jvm[i], ts[i], `${path}/${i}`))
    }
    return result
  }
  if (jvm && ts && typeof jvm === 'object' && typeof ts === 'object' && !Array.isArray(jvm) && !Array.isArray(ts)) {
    return [...new Set([...Object.keys(jvm), ...Object.keys(ts)])].sort().flatMap((key) => {
      const segment = key.replaceAll('~', '~0').replaceAll('/', '~1')
      if (!Object.hasOwn(jvm, key) || !Object.hasOwn(ts, key)) return [{ path: `${path}/${segment}`, jvm: Object.hasOwn(jvm, key) ? jvm[key] : { type: 'missing' }, ts: Object.hasOwn(ts, key) ? ts[key] : { type: 'missing' } }]
      return differences(jvm[key], ts[key], `${path}/${segment}`)
    })
  }
  return [{ path, jvm, ts }]
}
function observed(result, item, runtime, raw = false) {
  if (result.outcome === 'return') return { outcome: 'return', value: result.value }
  const mapping = raw ? undefined : item.errorEquivalence
  const matches = mapping?.[runtime]?.includes(result.error.class) && (mapping[`${runtime}MessageIncludes`] ?? []).every((text) => result.error.message.includes(text))
  const category = matches ? mapping.category : result.error.class
  // 原始异常与日志仍完整保存在 results；仅逐案例声明的异常类别参与语义映射。
  return matches ? { outcome: 'throw', errorClass: category } : { outcome: 'throw', errorClass: category, message: result.error.message }
}
export function compareCase(item, jvm, ts) {
  try { validateResult(jvm, item.id); validateResult(ts, item.id) } catch (error) {
    return { id: item.id, family: item.family, status: 'runner-failed', reason: error.message }
  }
  if (jvm.execution !== 'completed' || ts.execution !== 'completed') {
    return { id: item.id, family: item.family, contractScope: item.contractScope ?? 'api', rawComparison: 'not-run', behaviorComparison: 'not-run', status: [jvm.execution, ts.execution].includes('runner-failed') ? 'runner-failed' : 'unsupported', jvm, ts }
  }
  const rawDelta = differences(observed(jvm, item, 'jvm', true), observed(ts, item, 'ts', true))
  const left = observed(jvm, item, 'jvm')
  const right = observed(ts, item, 'ts')
  const delta = differences(left, right)
  const allowed = []
  const unexpected = []
  for (const entry of delta) {
    const match = item.allowedDifferences?.find((d) => d.path === entry.path && stable(d.jvm) === stable(entry.jvm) && stable(d.ts) === stable(entry.ts))
    if (match) allowed.push({ ...entry, reason: match.reason })
    else unexpected.push(entry)
  }
  const expectedFailures = []
  if (Object.hasOwn(item, 'expected')) {
    for (const [runtime, result] of [['jvm', left], ['ts', right]]) {
      for (const difference of differences(item.expected, result)) expectedFailures.push({ runtime, ...difference })
    }
  }
  return { id: item.id, family: item.family, contractScope: item.contractScope ?? 'api', rawComparison: rawDelta.length ? 'different' : 'equal', rawDifferences: rawDelta, errorEquivalent: rawDelta.length > 0 && delta.length === 0 && left.outcome === 'throw', behaviorComparison: unexpected.length || expectedFailures.length ? 'different' : allowed.length ? 'allowed-difference' : 'equal', status: unexpected.length || expectedFailures.length ? 'different' : allowed.length ? 'allowed-difference' : 'equal', differences: unexpected, allowed, expectedFailures }
}
export function assertProvenance(metadata, expected) {
  if (metadata.schemaVersion !== 1 || !metadata.inputHash || !metadata.implementationHash || metadata.inputHash !== expected.inputHash || metadata.implementationHash !== expected.implementationHash) throw new Error('产物版本或输入摘要不匹配，拒绝比较过期输出')
}

export function measureCoverage(entries, cases, comparisons, jvmResults) {
  const selected = new Map(cases.map((item, index) => [item.id, { item, comparison: comparisons[index], jvm: jvmResults[index] }]))
  return entries.map((entry) => {
    const relevant = entry.caseIds.map((id) => selected.get(id)).filter(Boolean)
    const passed = relevant.filter(({ comparison }) => comparison.contractScope === 'api' && comparison.status === 'equal')
    const dimensionEvidence = Object.fromEntries(entry.requiredDimensions.map((dimension) => [dimension, passed.filter(({ item, jvm }) => {
      if (dimension === 'edge') return item.tags.includes('edge') || item.tags.includes('boundary')
      if (dimension === 'error-or-empty') {
        const value = jvm.value
        return jvm.outcome === 'throw' || item.tags.includes('empty') || value === '' || value === null || (Array.isArray(value) && value.length === 0)
      }
      return item.tags.includes(dimension)
    }).map(({ item }) => item.id)]))
    const missingDimensions = entry.requiredDimensions.filter((name) => dimensionEvidence[name].length === 0)
    const has = (predicate) => relevant.some(({ comparison }) => predicate(comparison))
    let status = 'verified'
    if (relevant.length !== entry.caseIds.length) status = 'not-run'
    else if (has((c) => c.status === 'runner-failed')) status = 'blocked'
    else if (has((c) => c.contractScope === 'reference-observation')) status = 'reference-observation'
    else if (has((c) => c.status === 'unsupported')) status = 'unsupported'
    else if (has((c) => c.status === 'different')) status = 'different'
    else if (has((c) => c.status === 'allowed-difference')) status = 'allowed-difference'
    else if (missingDimensions.length > 0) status = 'incomplete'
    else if (has((c) => c.errorEquivalent)) status = 'error-equivalent'
    return { ...entry, selected: relevant.length, status, dimensionEvidence, missingDimensions }
  })
}
export function summarize(cases) {
  const counts = Object.fromEntries(['equal', 'different', 'allowed-difference', 'unsupported', 'runner-failed'].map((status) => [status, cases.filter((c) => c.status === status).length]))
  const api = cases.filter((c) => c.contractScope !== 'reference-observation')
  const apiCounts = Object.fromEntries(Object.keys(counts).map((status) => [status, api.filter((c) => c.status === status).length]))
  return { total: cases.length, ...counts, api: { total: api.length, ...apiCounts }, observations: cases.length - api.length, rawDifferent: cases.filter((c) => c.rawComparison === 'different').length, errorEquivalent: cases.filter((c) => c.errorEquivalent).length, exitCode: counts['runner-failed'] || apiCounts.unsupported ? 2 : apiCounts.different ? 1 : 0 }
}
