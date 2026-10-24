import assert from 'node:assert/strict'
import test from 'node:test'
import { readBookCovers } from '../src/lib/book-cover-queue.ts'
import type { BookSourceItem } from '../shared/book-sources.ts'

const sources: BookSourceItem[] = ['a', 'b', 'c'].map((id) => ({ status: 'discovered', candidateId: id, sourceId: id, sourceFingerprint: id, name: id, bookUrl: id, sourceEnabled: true }))

test('封面补取按来源顺序串行执行，空封面和失败不阻塞其他来源', async () => {
  let active = 0; let maxActive = 0
  const calls: string[] = []; const statuses: string[] = []
  await readBookCovers(sources, new AbortController().signal, async (source) => {
    active++; maxActive = Math.max(maxActive, active); calls.push(source.sourceId)
    await Promise.resolve(); active--
    if (source.sourceId === 'b') throw new Error('测试来源失败')
    return source.sourceId === 'c' ? undefined : 'https://covers.test/a.jpg'
  }, (source, result) => statuses.push(source.sourceId + ':' + result.status))
  assert.equal(maxActive, 1)
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.deepEqual(statuses, ['a:loading', 'a:ready', 'b:loading', 'b:failed', 'c:loading', 'c:empty'])
})

test('停止封面获取后忽略迟到响应，继续时只处理剩余来源', async () => {
  const controller = new AbortController()
  let finish!: (value: string) => void; let began!: () => void
  const waiting = new Promise<string>((resolve) => { finish = resolve })
  const started = new Promise<void>((resolve) => { began = resolve })
  const calls: string[] = []; const statuses: string[] = []
  const task = readBookCovers(sources, controller.signal, async (source) => {
    calls.push(source.sourceId)
    if (source.sourceId === 'a') return 'https://covers.test/a.jpg'
    began(); return waiting
  }, (source, result) => statuses.push(source.sourceId + ':' + result.status))
  await started
  controller.abort(); finish('https://covers.test/late.jpg'); await task
  assert.deepEqual(calls, ['a', 'b']); assert.deepEqual(statuses, ['a:loading', 'a:ready', 'b:loading'])
  await readBookCovers(sources.slice(1), new AbortController().signal, async (source) => { calls.push(source.sourceId); return 'https://covers.test/' + source.sourceId }, () => {})
  assert.deepEqual(calls, ['a', 'b', 'b', 'c'])
})

test('已中止的队列不发送请求，失败重试可以只指定一个来源', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await readBookCovers(sources, controller.signal, async () => { calls++; return undefined }, () => assert.fail('不应更新已取消结果'))
  assert.equal(calls, 0)
  await readBookCovers([sources[1]!], new AbortController().signal, async (source) => { calls++; assert.equal(source.sourceId, 'b'); return undefined }, () => {})
  assert.equal(calls, 1)
})
