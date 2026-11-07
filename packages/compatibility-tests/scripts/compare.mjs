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
function observed(result, item, runtime) {
  if (result.outcome === 'return') return { outcome: 'return', value: result.value }
  const mapping = item.errorEquivalence
  const category = mapping?.[runtime]?.includes(result.error.class) ? mapping.category : result.error.class
  // 原始异常与日志仍完整保存在 results；仅逐案例声明的异常类别参与语义映射。
  return mapping?.[runtime]?.includes(result.error.class) ? { outcome: 'throw', errorClass: category } : { outcome: 'throw', errorClass: category, message: result.error.message }
}
export function compareCase(item, jvm, ts) {
  try { validateResult(jvm, item.id); validateResult(ts, item.id) } catch (error) {
    return { id: item.id, family: item.family, status: 'runner-failed', reason: error.message }
  }
  if (jvm.execution !== 'completed' || ts.execution !== 'completed') {
    return { id: item.id, family: item.family, status: [jvm.execution, ts.execution].includes('runner-failed') ? 'runner-failed' : 'unsupported', jvm, ts }
  }
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
  return { id: item.id, family: item.family, status: unexpected.length || expectedFailures.length ? 'different' : allowed.length ? 'allowed-difference' : 'equal', differences: unexpected, allowed, expectedFailures }
}
export function assertProvenance(metadata, expected) {
  if (metadata.schemaVersion !== 1 || !metadata.inputHash || !metadata.implementationHash || metadata.inputHash !== expected.inputHash || metadata.implementationHash !== expected.implementationHash) throw new Error('产物版本或输入摘要不匹配，拒绝比较过期输出')
}
export function summarize(cases) {
  const counts = Object.fromEntries(['equal', 'different', 'allowed-difference', 'unsupported', 'runner-failed'].map((status) => [status, cases.filter((c) => c.status === status).length]))
  return { total: cases.length, ...counts, exitCode: counts.unsupported || counts['runner-failed'] ? 2 : counts.different ? 1 : 0 }
}
