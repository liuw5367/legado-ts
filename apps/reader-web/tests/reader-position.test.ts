import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorFromViewport, pageIndexForAnchor } from '../src/lib/reader-pagination.ts'

// 一个 HTML 段落含两个嵌套文本节点，跨三栏；模拟浏览器 Range 的字符坐标。
function paginatedParagraph() {
  const nodes = [{ textContent: '甲'.repeat(150), base: 0 }, { textContent: '乙'.repeat(150), base: 150 }]
  const viewportRect = { left: 0, right: 100, top: 0, bottom: 100 }
  const viewport = {
    scrollLeft: 100,
    getBoundingClientRect: () => viewportRect,
    querySelector: () => paragraph,
    querySelectorAll: () => [paragraph],
  }
  const paragraph = {
    dataset: { paragraph: '0' },
    getBoundingClientRect: () => ({ left: -viewport.scrollLeft, right: 300 - viewport.scrollLeft, top: 20, bottom: 80 }),
    ownerDocument: {
      createTreeWalker: () => {
        let index = 0
        return { nextNode: () => nodes[index++] ?? null }
      },
      createRange: () => {
        let character = 0
        return {
          setStart: (node: typeof nodes[number], offset: number) => { character = node.base + offset },
          setEnd: () => {},
          getBoundingClientRect: () => {
            const left = Math.floor(character / 100) * 100 + character % 100 * 0.8 + 2 - viewport.scrollLeft
            return { left, right: left + 0.8, top: 20, bottom: 40 }
          },
        }
      },
    },
  }
  return viewport
}

test('saving a page inside a spanning paragraph restores that page, including nested HTML text', () => {
  const viewport = paginatedParagraph()
  const element = viewport as unknown as HTMLElement
  for (const page of [0, 1, 2]) {
    viewport.scrollLeft = page * 100
    const anchor = anchorFromViewport(element)
    assert.deepEqual(anchor, { paragraphIndex: 0, offset: page * 100 })
    viewport.scrollLeft = 0
    assert.equal(pageIndexForAnchor(element, anchor!, { pageWidth: 100, pageCount: 3 }), page)
  }
  assert.equal(pageIndexForAnchor(element, { paragraphIndex: 0, offset: 100 }, { pageWidth: 200, pageCount: 2 }), 0)
})
