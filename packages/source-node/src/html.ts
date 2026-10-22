import { parseDocument } from 'htmlparser2'
import { isDocument, isText, isTag, type AnyNode } from 'domhandler'
import { getAttributeValue, getChildren, getText } from 'domutils'
import { selectAll } from 'css-select'
import { render } from 'dom-serializer'
import { ParserAdapterError, type HtmlDocument, type HtmlParser, type ParserNode } from '@legado/source-core'

class HtmlDocumentView implements HtmlDocument {
  private readonly ids = new Map<string, AnyNode>()
  private readonly reverse = new WeakMap<object, string>()
  private nextId = 0
  private readonly root: AnyNode
  private readonly xmlMode: boolean

  public constructor(root: AnyNode, xmlMode = false) {
    this.root = root
    this.xmlMode = xmlMode
  }

  public select(selector: string): ParserNode[] {
    try {
      return selectAll(selector, this.root, { xmlMode: this.xmlMode, pseudos: htmlPseudos }).map((node) => this.wrap(node))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ParserAdapterError('unsupported-selector', `CSS 选择器不受支持：${message}`, { cause: error })
    }
  }

  public children(): ParserNode[] {
    return getChildren(this.root).filter(isTag).map((node) => this.wrap(node))
  }

  public attr(node: ParserNode, name: string): string | undefined {
    const value = this.node(node)
    return isTag(value) ? getAttributeValue(value, name) : undefined
  }

  public read(node: ParserNode, output: 'text' | 'textNodes' | 'ownText' | 'html' | 'all'): string {
    const value = this.node(node)
    if (output === 'all') return render(value, { xmlMode: this.xmlMode, encodeEntities: false })
    if (output === 'html') {
      // Android's Jsoup branch returns outerHtml for `html`, after removing
      // script/style descendants from the selected elements.
      const copy = value.cloneNode(true)
      removeScriptAndStyle(copy)
      return render(copy, { xmlMode: this.xmlMode, encodeEntities: false })
    }
    if (output === 'text') return jsoupText(value)
    const children = isDocument(value) || isTag(value) ? getChildren(value) : []
    if (output === 'textNodes') return children.filter((child) => isText(child) && !isScriptOrStyle(child.parent)).map((child) => trimAndroidWhitespace(normalizeWhitespace(getText(child)))).filter(Boolean).join('\n')
    return children.filter((child) => isText(child) && !isScriptOrStyle(child.parent)).map((child) => trimAndroidWhitespace(normalizeWhitespace(getText(child)))).filter(Boolean).join('')
  }

  public child(node: ParserNode): HtmlDocument {
    return new HtmlDocumentView(this.node(node), this.xmlMode)
  }

  public raw(node: ParserNode): AnyNode {
    return this.node(node)
  }

  private wrap(node: AnyNode): ParserNode {
    const existing = this.reverse.get(node)
    if (existing !== undefined) return { id: existing, kind: this.kind(node) }
    const id = `n${this.nextId++}`
    this.reverse.set(node, id)
    this.ids.set(id, node)
    return { id, kind: this.kind(node) }
  }

  private node(reference: ParserNode): AnyNode {
    const value = this.ids.get(reference.id)
    if (value === undefined) throw new Error('node reference does not belong to this document')
    return value
  }

  private kind(node: AnyNode): ParserNode['kind'] {
    if (isDocument(node)) return 'document'
    if (isText(node)) return 'text'
    return 'element'
  }
}

function trimAndroidWhitespace(value: string): string {
  // Android String.trim() removes code units <= U+0020 from both ends.
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\s\u00a0]+/gu, ' ')
}

function isScriptOrStyle(node: AnyNode | null | undefined): boolean {
  return node !== null && node !== undefined && isTag(node) && (node.name === 'script' || node.name === 'style')
}

const blockElements = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'])

/** Jsoup Element.text 的可移植子集：忽略 data 节点、规范空白并在块级元素间补分隔。 */
function jsoupText(node: AnyNode): string {
  const chunks: string[] = []
  // 保留文本节点中的换行：规则替换依赖 `\\n`，块级元素之间再单独补空格。
  const append = (value: string): void => { if (value.length > 0) chunks.push(value.replace(/[ \t\f\v\r]+/gu, ' ')) }
  const visit = (current: AnyNode): void => {
    if (isScriptOrStyle(current)) return
    if (isText(current)) { append(getText(current)); return }
    if (!isDocument(current) && isTag(current) && blockElements.has(current.name)) append(' ')
    for (const child of getChildren(current)) visit(child)
    if (!isDocument(current) && isTag(current) && blockElements.has(current.name)) append(' ')
  }
  visit(node)
  return chunks.join('').replace(/[ \t\f\v\r]+/gu, ' ').trim()
}

function ownTextValue(node: AnyNode): string {
  if (!isDocument(node) && !isTag(node)) return ''
  return getChildren(node).filter((child) => isText(child) && !isScriptOrStyle(child.parent)).map((child) => getText(child)).join('').replace(/[\s\u00a0]+/gu, ' ').trim()
}

function elementSiblingIndex(node: AnyNode): number {
  const siblings = node.parent === null ? [] : getChildren(node.parent).filter(isTag)
  return siblings.findIndex((item) => item === node)
}

function pseudoNumber(value: string | null | undefined): number {
  const number = Number.parseInt(value ?? '', 10)
  if (!Number.isSafeInteger(number)) throw new Error(`invalid pseudo index: ${value ?? ''}`)
  return number
}

function pseudoRegex(value: string | null | undefined): RegExp {
  const text = (value ?? '').trim()
  const literal = /^\/(.*)\/([dgimsuvy]*)$/su.exec(text)
  try { return literal === null ? new RegExp(text) : new RegExp(literal[1]!, literal[2]) } catch { throw new Error(`invalid pseudo regex: ${text}`) }
}

const htmlPseudos: Record<string, (element: AnyNode, value?: string | null) => boolean> = {
  // Jsoup 的 eq/lt/gt 使用元素在同级元素中的 0 基索引，不使用筛选结果集合索引。
  eq: (element, value) => { const index = elementSiblingIndex(element); const expected = pseudoNumber(value); return index === (expected < 0 ? index + 1 + expected : expected) },
  lt: (element, value) => { const index = elementSiblingIndex(element); const expected = pseudoNumber(value); return index < (expected < 0 ? index + 1 + expected : expected) },
  gt: (element, value) => { const index = elementSiblingIndex(element); const expected = pseudoNumber(value); return index > (expected < 0 ? index + 1 + expected : expected) },
  containsown: (element, value) => ownTextValue(element).includes(value ?? ''),
  matchesown: (element, value) => pseudoRegex(value).test(ownTextValue(element)),
  matches: (element, value) => pseudoRegex(value).test(jsoupText(element)),
}

function removeScriptAndStyle(node: AnyNode): void {
  if (!isDocument(node) && !isTag(node)) return
  node.children = node.children.filter((child) => {
    if (isTag(child) && (child.name === 'script' || child.name === 'style')) return false
    removeScriptAndStyle(child)
    return true
  })
}

export class HtmlParserAdapter implements HtmlParser {
  public parse(input: string, mode: 'html' | 'xml' = 'html'): HtmlDocument {
    return new HtmlDocumentView(parseDocument(input, { xmlMode: mode === 'xml' }), mode === 'xml')
  }
}
