import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshSubscription } from '../src/public/index.ts'
import type { NormalizedSource } from '../src/public/index.ts'

function make(url: string, extra: Record<string, unknown> = {}): NormalizedSource {
  return { bookSourceUrl: url, bookSourceName: url, ...extra } as NormalizedSource
}

test('订阅新增只返回提交计划，不写入本地', async () => {
  const plan = await refreshSubscription({ subscriptionId: 'sub', operationId: 'op', baseSubscriptionRevision: 'r1', baseline: [], local: [], remoteSources: [make('A')] })
  assert.equal(plan.outcome, 'updated')
  assert.deepEqual(plan.diffs, [{ sourceId: 'A', kind: 'added', fields: ['bookSourceName', 'bookSourceUrl'] }])
  assert.deepEqual(plan.commitPlan.sourceIds, ['A'])
})

test('远程和本地同时修改同一字段时产生冲突', async () => {
  const baseline = make('A', { header: 'base', bookSourceName: 'old' })
  const remote = make('A', { header: 'remote', bookSourceName: 'old' })
  const local = make('A', { header: 'local', bookSourceName: 'old' })
  const plan = await refreshSubscription({ subscriptionId: 'sub', operationId: 'op', baseSubscriptionRevision: 'r1', baseline: [{ sourceId: 'A', source: baseline }], local: [{ sourceId: 'A', source: local, sourceRevision: 's2' }], remoteSources: [remote] })
  assert.equal(plan.outcome, 'conflict')
  assert.deepEqual(plan.diffs[0]?.fields, ['header'])
  assert.equal(plan.commitPlan.expectedSourceRevisions.A, 's2')
})

test('远程缺失保留为待确认差异，取消不读取网络', async () => {
  const plan = await refreshSubscription({ subscriptionId: 'sub', operationId: 'op', baseSubscriptionRevision: 'r1', baseline: [{ sourceId: 'A', source: make('A') }], local: [{ sourceId: 'A', source: make('A') }], remoteSources: [] })
  assert.equal(plan.diffs[0]?.kind, 'remote-missing')
  const controller = new AbortController()
  controller.abort()
  const cancelled = await refreshSubscription({ subscriptionId: 'sub', operationId: 'op', baseSubscriptionRevision: 'r1', baseline: [], local: [], url: 'https://example.test', signal: controller.signal, reader: { read: async () => { throw new Error('must not read') } } })
  assert.equal(cancelled.outcome, 'cancelled')
})
