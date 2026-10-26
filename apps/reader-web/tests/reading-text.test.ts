import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnchor, createCachedChapter } from '../shared/reading-text.ts'

test('短章节缓存完整段落和选区位置', () => {
  const paragraphs = ['第一段正文。', '第二段正文。']
  const anchor = createAnchor(paragraphs, { paragraphIndex: 1, offset: 2 }, { paragraphIndex: 1, offset: 5 }, 'hash')
  const cached = createCachedChapter(paragraphs, anchor)
  assert.deepEqual(cached.paragraphs, paragraphs)
  assert.deepEqual(cached.start, anchor.start)
  assert.deepEqual(cached.end, anchor.end)
  assert.equal(cached.truncatedBefore, false)
  assert.equal(cached.truncatedAfter, false)
})

test('长章节窗口限制为 2000 字并将标记放在窗口中间附近', () => {
  const text = '甲'.repeat(5000) + '标记内容' + '乙'.repeat(5000)
  const anchor = createAnchor([text], { paragraphIndex: 0, offset: 5000 }, { paragraphIndex: 0, offset: 5004 }, 'hash')
  const cached = createCachedChapter([text], anchor)
  const snippet = cached.paragraphs.join('\n')
  assert.equal(snippet.length, 2000)
  assert.equal(snippet.slice(cached.start.offset, cached.end.offset), '标记内容')
  assert.ok(cached.start.offset >= 900 && cached.start.offset <= 1100)
  assert.equal(cached.truncatedBefore, true)
  assert.equal(cached.truncatedAfter, true)
})

test('章节首尾的缓存窗口会贴近边缘并标识裁剪方向', () => {
  const text = '标记内容' + '乙'.repeat(5000)
  const anchor = createAnchor([text], { paragraphIndex: 0, offset: 0 }, { paragraphIndex: 0, offset: 4 }, 'hash')
  const cached = createCachedChapter([text], anchor)
  assert.equal(cached.paragraphs.join('\n').slice(cached.start.offset, cached.end.offset), '标记内容')
  assert.equal(cached.truncatedBefore, false)
  assert.equal(cached.truncatedAfter, true)
})

test('选区长于缓存上限时仍缓存 2000 字并保留可显示的标记范围', () => {
  const text = '甲'.repeat(3000)
  const anchor = createAnchor([text], { paragraphIndex: 0, offset: 0 }, { paragraphIndex: 0, offset: 3000 }, 'hash')
  const cached = createCachedChapter([text], anchor)
  assert.equal(cached.paragraphs.join('\n').length, 2000)
  assert.equal(cached.end.offset - cached.start.offset, 2000)
  assert.equal(cached.truncatedBefore, true)
  assert.equal(cached.truncatedAfter, true)
})
