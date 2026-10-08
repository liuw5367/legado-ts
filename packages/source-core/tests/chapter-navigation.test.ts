import test from 'node:test'
import assert from 'node:assert/strict'
import { nextChapterUrlFor } from '../src/index.ts'
import type { Chapter } from '../src/index.ts'

function chapter(index: number, chapterUrl: string, url?: string): Chapter {
  return { sourceId: 'source', bookUrl: 'https://book.test/book', chapterUrl, index, title: `第${index + 1}章`, rawFields: {}, traceRef: `chapter:${index}`, ...(url === undefined ? {} : { url }) }
}

test('下一章地址按当前章节匹配并优先返回原始 URL', () => {
  const chapters = [chapter(0, 'https://book.test/c1'), chapter(1, 'https://book.test/c2', ' /c2 '), chapter(2, 'https://book.test/c3')]
  assert.equal(nextChapterUrlFor(chapters, chapters[0]!), '/c2')
})

test('索引失效时按章节 URL 定位，并在末章回到第一章', () => {
  const chapters = [chapter(0, 'https://book.test/c1'), chapter(1, 'https://book.test/c2')]
  const current = { ...chapters[1]!, index: 99 }
  assert.equal(nextChapterUrlFor(chapters, current), 'https://book.test/c1')
})

test('找不到当前章节或目录为空时不猜测下一章', () => {
  const chapters = [chapter(0, 'https://book.test/c1')]
  assert.equal(nextChapterUrlFor(undefined, chapters[0]!), undefined)
  assert.equal(nextChapterUrlFor([], chapters[0]!), undefined)
  assert.equal(nextChapterUrlFor(chapters, chapter(3, 'https://book.test/missing')), undefined)
})
