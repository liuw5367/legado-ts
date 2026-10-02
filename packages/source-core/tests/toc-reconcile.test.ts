import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileTableOfContents } from '../src/index.ts'
import type { Chapter } from '../src/index.ts'

function chapter(input: Partial<Chapter> & Pick<Chapter, 'title' | 'chapterUrl' | 'index'>): Chapter {
  const { title, chapterUrl, index, ...rest } = input
  return {
    sourceId: 'https://source.test',
    bookUrl: 'https://source.test/book',
    title,
    chapterUrl,
    index,
    rawFields: {},
    traceRef: `toc:${index}`,
    ...rest,
  }
}

test('目录 reconcile 按 Android 索引标题延续章节元数据并生成书籍 patch', () => {
  const previous = [
    chapter({ title: '第一章', chapterUrl: 'https://source.test/c1', index: 0, wordCount: '100字', variable: '{"old":1}', imgUrl: 'https://img.test/old.png' }),
  ]
  const current = [
    chapter({ title: '第一章', chapterUrl: 'https://source.test/c1', index: 9 }),
    chapter({ title: '第二章', chapterUrl: 'https://source.test/c2', index: 8 }),
  ]
  const result = reconcileTableOfContents({ chapters: current, previousChapters: previous, book: { totalChapterNum: 1, durChapterIndex: 1, simulatedTotalChapterNum: 2 }, now: 123, carryMetadata: true })
  assert.deepEqual(result.chapters.map((item) => [item.index, item.wordCount, item.variable, item.imgUrl]), [[0, '100字', '{"old":1}', 'https://img.test/old.png'], [1, undefined, undefined, undefined]])
  assert.deepEqual(result.bookPatch, { durChapterTitle: '第二章', latestChapterTitle: '第二章', lastCheckCount: 1, latestChapterTime: 123, lastCheckTime: 123, totalChapterNum: 2 })
  assert.deepEqual(result.carriedMetadata, [{ index: 0, fields: ['wordCount', 'variable', 'imgUrl'] }])
  assert.deepEqual(result.changes.map((item) => item.kind), ['added'])
})

test('目录 reconcile 报告新增、删除、移动和字段变化，不产生存储副作用', () => {
  const previous = [
    chapter({ title: '第一章', chapterUrl: 'https://source.test/c1', index: 0 }),
    chapter({ title: '第二章', chapterUrl: 'https://source.test/c2', index: 1 }),
  ]
  const current = [
    chapter({ title: '第二章（修订）', chapterUrl: 'https://source.test/c2', index: 0 }),
    chapter({ title: '第三章', chapterUrl: 'https://source.test/c3', index: 1 }),
  ]
  const result = reconcileTableOfContents({ chapters: current, previousChapters: previous, book: { totalChapterNum: 2, durChapterIndex: 0 }, now: 456 })
  assert.deepEqual(result.chapters.map((item) => item.index), [0, 1])
  assert.deepEqual(result.changes.map((item) => item.kind), ['moved', 'updated', 'added', 'removed'])
  assert.equal(result.bookPatch.lastCheckCount, undefined)
  assert.equal(result.bookPatch.latestChapterTime, undefined)
})

test('目录 reconcile 为空时仍返回确定的总数和时间 patch', () => {
  const result = reconcileTableOfContents({ chapters: [], book: { totalChapterNum: 2, durChapterIndex: 0 }, now: 789 })
  assert.deepEqual(result.bookPatch, { lastCheckTime: 789, totalChapterNum: 0 })
  assert.deepEqual(result.changes, [])
})

test('目录 reconcile 的越界阅读索引按 Android getOrElse 回退末章', () => {
  const result = reconcileTableOfContents({
    chapters: [chapter({ title: '第一章', chapterUrl: 'https://source.test/c1', index: 4 }), chapter({ title: '第二章', chapterUrl: 'https://source.test/c2', index: 5 })],
    book: { totalChapterNum: 2, durChapterIndex: 99, simulatedTotalChapterNum: 0 },
    now: 999,
  })
  assert.equal(result.bookPatch.durChapterTitle, '第二章')
  assert.equal(result.bookPatch.latestChapterTitle, '第二章')
})
