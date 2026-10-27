import { normalizeReadingContent, type ReadingContentInput, type ReadingDocument, type ReadingHtmlNode } from '@legado/source-core'

/** DOMParser 不执行正文脚本；只暴露节点视图，过滤和断段规则集中在 core。 */
export function parseReadingHtml(html: string): readonly ReadingHtmlNode[] {
  const view = (node: Node): ReadingHtmlNode[] => {
    if (node.nodeType === Node.TEXT_NODE) return [{ kind: 'text', text: node.textContent ?? '' }]
    if (!(node instanceof Element)) return []
    return [{ kind: 'element', tag: node.tagName.toLowerCase(), attributes: Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value])), get children() { return [...node.childNodes].flatMap(view) } }]
  }
  return [...new DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html').body.childNodes].flatMap(view)
}

export function readingDocument(content: ReadingContentInput): ReadingDocument {
  return normalizeReadingContent(content, parseReadingHtml)
}
