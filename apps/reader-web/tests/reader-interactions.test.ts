import assert from 'node:assert/strict'
import test from 'node:test'
import { chapterCharacterCount, isCurrentToc, isReaderTap } from '../src/lib/reader-interactions.ts'
import { pageReturnTarget } from '../src/lib/page-navigation.ts'

test('chapter count excludes whitespace and counts Unicode code points', () => {
  assert.equal(chapterCharacterCount('甲乙\n 丙。 A1 😀\u3000'), 7)
  assert.equal(chapterCharacterCount(' \t\n'), 0)
})
test('reader taps exclude scrolling, dragging and selecting text', () => {
  const start = { x: 50, y: 60, scrollY: 300 }
  assert.equal(isReaderTap(start, { ...start, x: 52 }, ''), true)
  assert.equal(isReaderTap(start, { ...start, x: 90 }, ''), false)
  assert.equal(isReaderTap(start, { ...start, scrollY: 310 }, ''), false)
  assert.equal(isReaderTap(start, start, '选中文字'), false)
})
test('TOC responses from another book or source are not current', () => {
  const toc = { bookId: 'book-a', editionKey: 'source-a' }
  assert.equal(isCurrentToc(toc, 'book-a', 'source-a'), true)
  assert.equal(isCurrentToc(toc, 'book-a', 'source-b'), false)
  assert.equal(isCurrentToc(toc, 'book-b', 'source-a'), false)
  assert.equal(isCurrentToc(null, 'book-a', 'source-a'), false)
})
test('page return preserves parent state and rejects external/self targets', () => {
  assert.deepEqual(pageReturnTarget({ backTo: '/search?q=书', backState: { backTo: '/' } }, '/books/b/toc', '/'), { to: '/search?q=书', state: { backTo: '/' } })
  for (const backTo of ['//evil.example', '/\\evil.example', 'https://evil.example', '/books/b/toc?editionKey=old', '/\nmalformed']) assert.equal(pageReturnTarget({ backTo }, '/books/b/toc', '/').to, '/')
})
