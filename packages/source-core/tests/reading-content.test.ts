import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReadingContent, readingImageUrl, readingParagraphTexts, type ReadingHtmlNode } from '../src/reading/content.ts'

test('纯文本无需 HTML 宿主，换行与实体字面量保持稳定', () => {
  const document = normalizeReadingContent({ contentType: 'text', cleaned: '甲😀乙\r\n第二段 &amp;', resources: [] })
  assert.deepEqual(readingParagraphTexts(document), ['甲😀乙', '第二段 &amp;'])
})
test('需要解释 HTML 或 text 内嵌图片时必须具备解析能力', () => {
  for (const [contentType, cleaned] of [['html', '<p>正文</p>'], ['text', '<img src="/a.png">']] as const) {
    assert.throws(() => normalizeReadingContent({ contentType, cleaned, resources: [] }), /capability-missing/u)
  }
})
test('按宿主节点顺序生成受控格式和图片，丢弃脚本子树', () => {
  const nodes: ReadingHtmlNode[] = [{ kind: 'element', tag: 'p', attributes: {}, children: [
    { kind: 'text', text: '甲' },
    { kind: 'element', tag: 'b', attributes: {}, children: [{ kind: 'text', text: '乙' }] },
    { kind: 'element', tag: 'img', attributes: { src: '/a.png' }, children: [] },
    { kind: 'element', tag: 'script', attributes: {}, children: [{ kind: 'text', text: '危险' }] },
    { kind: 'text', text: '丙' },
  ] }]
  const document = normalizeReadingContent({ contentType: 'html', cleaned: '<p>fixture</p>', resources: [], baseUrl: 'https://book.test/1' }, () => nodes)
  assert.deepEqual(readingParagraphTexts(document), ['甲乙', '', '丙'])
  assert.deepEqual(document.blocks[0], { kind: 'paragraph', runs: [{ text: '甲', formats: [] }, { text: '乙', formats: ['bold'] }] })
})
test('深层 HTML 节点不会使 core 遍历递归溢出', () => {
  let node: ReadingHtmlNode = { kind: 'text', text: '深层正文' }
  for (let n = 0; n < 20000; n++) node = { kind: 'element', tag: 'span', attributes: {}, children: [node] }
  assert.deepEqual(readingParagraphTexts(normalizeReadingContent({ contentType: 'html', cleaned: '<span>fixture</span>', resources: [] }, () => [node])), ['深层正文'])
})
test('图片 URL 限定 HTTP(S) 和位图 data URL', () => {
  assert.equal(readingImageUrl('../a.png', 'https://book.test/chapter/1'), 'https://book.test/a.png')
  assert.equal(readingImageUrl('data:image/png;base64,YQ=='), 'data:image/png;base64,YQ==')
  for (const url of ['javascript:alert(1)', 'file:///a.png', '/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,YQ==']) assert.equal(readingImageUrl(url), undefined)
})
