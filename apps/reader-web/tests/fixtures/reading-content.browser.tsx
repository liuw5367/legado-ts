import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useState } from 'react'
import { normalizeReadingContent, readingParagraphTexts, type ReadingDocument } from '@legado/source-core'
import { readingContentCases } from '../../../../packages/source-core/tests/fixtures/reading-content.ts'
import { pageCountFromScrollWidth, pageIndexForAnchor } from '../../src/lib/reader-pagination.ts'
import { ReaderBody } from '../../src/components/reader-body.tsx'
import { parseReadingHtml } from '../../src/lib/html-content.ts'
import { createAnchor, selectedAnchor, rangeForAnchor, paragraphTexts, textFingerprint, visibleTextPoint } from '../../src/lib/reader-annotations.ts'
import type { ReadingMark } from '../../shared/reading-annotations.ts'
import '../../src/styles.css'

declare const __NODE_READING_DOCS__: ReadingDocument[]

const report = document.createElement('pre'); report.id = 'results'; document.body.append(report)
const mount = document.createElement('div'); document.body.append(mount)
const root = createRoot(mount)
let count = 0
function equal(actual: unknown, expected: unknown, name: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(name + '\n实际：' + JSON.stringify(actual) + '\n预期：' + JSON.stringify(expected))
  count++
}
const marks: ReadingMark[] = []
try {
  for (const [fixtureIndex, fixture] of readingContentCases.entries()) {
    const documentValue = normalizeReadingContent(fixture.input, parseReadingHtml)
    equal(documentValue, __NODE_READING_DOCS__[fixtureIndex], fixture.name + ' 浏览器与 Node 完整模型一致')
    equal(readingParagraphTexts(documentValue), fixture.texts, fixture.name)
    equal(documentValue.blocks.map((block) => block.kind), fixture.kinds, fixture.name + '块类型')
    flushSync(() => root.render(<article className="reader-content"><ReaderBody document={documentValue} marks={marks} /></article>))
    const article = mount.querySelector('article')!
    equal(paragraphTexts(article), fixture.texts, fixture.name + ' DOM 文本')
    equal(article.querySelectorAll('script,iframe,svg,a,[style]').length, 0, fixture.name + ' 无危险或来源节点')
  }
  const input = { contentType: 'html' as const, cleaned: '<p>甲😀<b>乙丙</b>丁</p><p>下一段</p>', resources: [] }
  const documentValue = normalizeReadingContent(input, parseReadingHtml)
  const texts = readingParagraphTexts(documentValue); const hash = textFingerprint(input.cleaned)
  const anchor = createAnchor(texts, { paragraphIndex: 0, offset: 1 }, { paragraphIndex: 1, offset: 2 }, hash)
  function View() {
    const [version, update] = useState(0)
    return <><button onClick={() => update((n) => n + 1)}>模拟工具栏更新 {version}</button><article className="reader-content"><ReaderBody document={documentValue} marks={marks} /></article></>
  }
  flushSync(() => root.render(<View />))
  const article = mount.querySelector('article')!; const firstText = article.querySelector('p')!.firstChild
  const range = rangeForAnchor(article, anchor)!
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  equal(selectedAnchor(article, hash)?.anchor, anchor, '跨格式、跨段和 UTF-16 选区')
  flushSync(() => mount.querySelector('button')!.click())
  equal(article.querySelector('p')!.firstChild === firstText, true, '工具栏更新保持文本节点身份')
  equal(selectedAnchor(article, hash)?.anchor, anchor, '重渲染后选区保持')
  const mark = { id: 'fixture-mark', color: 'orange', note: null, anchor } as ReadingMark
  flushSync(() => root.render(<article className="reader-content"><ReaderBody document={documentValue} marks={[mark]} /></article>))
  const marked = mount.querySelector('article')!
  equal(paragraphTexts(marked), texts, '高亮不改变文字或索引')
  equal([...marked.querySelectorAll('[data-mark-id]')].map((node) => node.textContent).join(''), '😀乙丙丁下一', '跨格式与跨段高亮')
  window.getSelection()!.removeAllRanges()
  const imageDocument = normalizeReadingContent({ contentType: 'text', cleaned: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWb8AAAAASUVORK5CYII=">\n图片后正文', resources: [] }, parseReadingHtml)
  flushSync(() => root.render(<article className="reader-content" style={{ position: 'fixed', top: 24, left: 0, width: 390, height: 600, padding: 16 }}><ReaderBody document={imageDocument} marks={marks} /></article>))
  equal(visibleTextPoint(mount.querySelector('article')!, false)?.paragraphIndex, 1, '滚动模式图片之后仍可创建文字书签')
  equal(visibleTextPoint(mount.querySelector('article')!, true)?.paragraphIndex, 1, '分页模式图片之后仍可创建文字书签')
  const pagedDocument = normalizeReadingContent({ contentType: 'text', cleaned: '第一页\n[newpage]\n第二页', resources: [] })
  flushSync(() => root.render(<article className="reader-content reader-content-paged" style={{ position: 'fixed', top: 24, left: 0, width: 390, height: 300, minHeight: 300, maxHeight: 300, paddingTop: 0, paddingBottom: 0, columnWidth: 390 }}><ReaderBody document={pagedDocument} marks={marks} /></article>))
  const paged = mount.querySelector('article')!
  const layout = { pageWidth: 390, pageCount: pageCountFromScrollWidth(paged.scrollWidth, 390) }
  equal(layout.pageCount, 2, '显式分页产生两栏')
  equal(pageIndexForAnchor(paged, { paragraphIndex: 2, offset: 0 }, layout), 1, '显式分页后文字定位到第二页')
  equal(getComputedStyle(paged).touchAction, 'pan-y pinch-zoom', '正文保留纵向原生手势与缩放')
  equal(getComputedStyle(paged).userSelect, 'text', '正文允许系统文字选择')
  report.dataset.status = 'passed'; report.textContent = `PASS ${count} assertions\n包含真实 DOMParser、React 正文、DOM Range、跨段高亮及节点稳定性。\n原生手机长按需另外真机验证。`
} catch (error) {
  report.dataset.status = 'failed'; report.textContent = String(error); throw error
}
