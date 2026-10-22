import { DOMParser } from '@xmldom/xmldom'
import { selectAll } from 'css-select'
import fontoxpath from 'fontoxpath'
import { parseDocument } from 'htmlparser2'
import { render } from 'dom-serializer'
import { compileSourcePattern, ParserAdapterError } from '@legado/source-core'
import type { HtmlDocument, ParserNode, ParserNodeInfo, ParserNodeMutation, RuleValue, XPathParser } from '@legado/source-core'

const { evaluateXPath, ReturnType } = fontoxpath

type XmlNode = {
  nodeType: number
  nodeName?: string
  nodeValue?: string | null
  textContent?: string | null
  parentNode?: XmlNode | null
  childNodes?: { length: number; item(index: number): XmlNode | null }
  attributes?: { length: number; item(index: number): { name: string; value: string } | null }
  cloneNode?: (deep?: boolean) => XmlNode
  removeChild?: (child: XmlNode) => XmlNode
  setAttribute?: (name: string, value: string) => void
  removeAttribute?: (name: string) => void
  toString?: () => string
}

const cssAdapter = {
  isTag: (node: XmlNode): node is XmlNode => node.nodeType === 1,
  getAttributeValue: (element: XmlNode, name: string) => attributeValue(element, name),
  getChildren: (node: XmlNode) => childNodes(node),
  getName: (element: XmlNode) => element.nodeName ?? '',
  getParent: (node: XmlNode) => node.parentNode ?? null,
  getSiblings: (node: XmlNode) => node.parentNode === null || node.parentNode === undefined ? [node] : childNodes(node.parentNode),
  getText: (node: XmlNode) => node.textContent ?? node.nodeValue ?? '',
  hasAttrib: (element: XmlNode, name: string) => attributeValue(element, name) !== undefined,
  removeSubsets: (nodes: XmlNode[]) => nodes.filter((node, index) => !nodes.some((other, otherIndex) => index !== otherIndex && isAncestor(other, node))),
  equals: (left: XmlNode, right: XmlNode) => left === right,
}

class XmlDocumentView implements HtmlDocument {
  private readonly ids = new Map<string, XmlNode>()
  private readonly reverse = new WeakMap<object, string>()
  private nextId = 0
  private readonly root: XmlNode

  public constructor(root: XmlNode) {
    this.root = root
  }

  public select(selector: string): ParserNode[] {
    try {
      const normalized = normalizeXmlSelector(selector)
      return selectAll<XmlNode, XmlNode>(normalized.selector, this.root, { adapter: cssAdapter, xmlMode: true, pseudos: normalized.pseudos }).map((node) => this.wrap(node))
    } catch (error) {
      if (error instanceof ParserAdapterError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ParserAdapterError('unsupported-selector', `XML CSS 选择器不受支持：${message}`, { cause: error })
    }
  }

  public children(): ParserNode[] {
    return childNodes(this.root).filter((node) => node.nodeType === 1).map((node) => this.wrap(node))
  }

  public attr(node: ParserNode, name: string): string | undefined {
    const value = this.node(node)
    for (let index = 0; index < (value.attributes?.length ?? 0); index += 1) {
      const attribute = value.attributes?.item(index)
      if (attribute?.name === name) return attribute.value
    }
    return undefined
  }

  public read(node: ParserNode, output: 'text' | 'textNodes' | 'ownText' | 'html' | 'all'): string {
    const value = this.node(node)
    if (output === 'text') return normalizeXmlText(value.textContent ?? value.nodeValue ?? '')
    const children = childNodes(value)
    if (output === 'textNodes') return children.filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => normalizeXmlText(child.nodeValue ?? '')).filter(Boolean).join('\n')
    if (output === 'ownText') return normalizeXmlText(children.filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').join(''))
    if (output === 'html') return children.map((child) => child.toString?.() ?? '').join('')
    return value.toString?.() ?? ''
  }

  public child(node: ParserNode): HtmlDocument {
    return new XmlDocumentView(this.node(node))
  }

  public describe(node: ParserNode): ParserNodeInfo {
    const value = this.node(node)
    const parent = value.parentNode ?? null
    const elementSiblings = parent === null ? [] : childNodes(parent).filter((item) => item.nodeType === 1)
    const siblingIndex = elementSiblings.indexOf(value)
    const parents: ParserNode[] = []
    let current = parent
    while (current !== null) {
      parents.push(this.wrap(current))
      current = current.parentNode ?? null
    }
    const info: ParserNodeInfo = {
      parent: parent === null ? null : this.wrap(parent),
      parents,
      children: childNodes(value).filter((item) => item.nodeType === 1).map((item) => this.wrap(item)),
      previousSibling: siblingIndex > 0 ? this.wrap(elementSiblings[siblingIndex - 1]!) : null,
      nextSibling: siblingIndex >= 0 && siblingIndex + 1 < elementSiblings.length ? this.wrap(elementSiblings[siblingIndex + 1]!) : null,
    }
    if (value.nodeType === 1) {
      info.tagName = value.nodeName ?? ''
      info.id = attributeValue(value, 'id') ?? ''
      info.className = attributeValue(value, 'class') ?? ''
      const attributes: Record<string, string> = {}
      for (let index = 0; index < (value.attributes?.length ?? 0); index += 1) {
        const attribute = value.attributes?.item(index)
        if (attribute !== null && attribute !== undefined) attributes[attribute.name] = attribute.value
      }
      info.attributes = attributes
    }
    return info
  }

  public mutate(node: ParserNode, mutation: ParserNodeMutation): ParserNode | undefined {
    const value = this.node(node)
    if (mutation.operation === 'clone') {
      const clone = value.cloneNode?.(true)
      return clone === undefined ? undefined : this.wrap(clone)
    }
    if (mutation.operation === 'remove') {
      value.parentNode?.removeChild?.(value)
      return undefined
    }
    if (value.nodeType !== 1) return undefined
    if (mutation.value === null || mutation.value === undefined) value.removeAttribute?.(mutation.name)
    else value.setAttribute?.(mutation.name, mutation.value)
    return undefined
  }

  public raw(node: ParserNode): XmlNode {
    return this.node(node)
  }

  public context(): XmlNode {
    return this.root
  }

  public wrap(value: XmlNode): ParserNode {
    const existing = this.reverse.get(value)
    if (existing !== undefined) return { id: existing, kind: value.nodeType === 3 ? 'text' : value.nodeType === 9 ? 'document' : 'element' }
    const id = `x${this.nextId++}`
    this.reverse.set(value, id)
    this.ids.set(id, value)
    return { id, kind: value.nodeType === 3 ? 'text' : value.nodeType === 9 ? 'document' : 'element' }
  }

  private node(reference: ParserNode): XmlNode {
    const value = this.ids.get(reference.id)
    if (value === undefined) throw new Error('node reference does not belong to this XML document')
    return value
  }
}

function trimAndroidWhitespace(value: string): string {
  // Android String.trim() removes code units <= U+0020 from both ends.
  return value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
}

function normalizeXmlText(value: string): string {
  return trimAndroidWhitespace(value.replace(/[\s\u00a0]+/gu, ' '))
}

function xmlSiblingIndex(node: XmlNode): number {
  const parent = node.parentNode
  if (parent === null || parent === undefined) return -1
  return childNodes(parent).filter((item) => item.nodeType === 1).indexOf(node)
}

function xmlPseudoNumber(value: string | null | undefined): number {
  const number = Number.parseInt(value ?? '', 10)
  if (!Number.isSafeInteger(number)) throw new Error(`invalid pseudo index: ${value ?? ''}`)
  return number
}

function xmlPseudoRegex(value: string | null | undefined): RegExp {
  let source = (value ?? '').trim()
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/u.exec(source)
  if (quoted !== null) source = quoted[1] ?? quoted[2] ?? ''
  const literal = /^\/((?:\\.|[^/\\])*)\/([dgimsuvy]*)$/su.exec(source)
  const compiled = literal === null
    ? compileSourcePattern(source)
    : compileSourcePattern(literal[1]!, { flags: literal[2] ?? '' })
  if ('error' in compiled) throw new ParserAdapterError('unsupported-selector', `XML CSS 文本正则不受支持：${compiled.error.message}`)
  return compiled.regex
}

const xmlPseudos: Record<string, (element: XmlNode, value?: string | null) => boolean> = {
  // 与 Jsoup Evaluator.Index* 一致：负数不表示从末尾倒数。
  legadoeq: (element, value) => xmlSiblingIndex(element) === xmlPseudoNumber(value),
  legadolt: (element, value) => xmlSiblingIndex(element) < xmlPseudoNumber(value),
  legadogt: (element, value) => xmlSiblingIndex(element) > xmlPseudoNumber(value),
  legadocontainsown: (element, value) => {
    const own = childNodes(element).filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').join('')
    return normalizeXmlText(own).includes(value ?? '')
  },
  legadomatchesown: (element, value) => {
    const own = childNodes(element).filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').join('')
    return xmlPseudoRegex(value).test(normalizeXmlText(own))
  },
  legadomatches: (element, value) => xmlPseudoRegex(value).test(normalizeXmlText(element.textContent ?? '')),
}

interface NormalizedXmlSelector {
  selector: string
  pseudos: Record<string, (element: XmlNode, value?: string | null) => boolean>
}

function normalizeXmlSelector(selector: string): NormalizedXmlSelector {
  const dynamic: Record<string, (element: XmlNode, value?: string | null) => boolean> = {}
  let output = ''
  let index = 0
  let sequence = 0
  while (index < selector.length) {
    const pseudo = /^:(containsown|matchesown|matches|eq|lt|gt)\(/iu.exec(selector.slice(index))
    if (pseudo !== null) {
      output += `:legado${pseudo[1]!.toLowerCase()}(`
      index += pseudo[0].length
      continue
    }
    if (selector[index] === '[') {
      const end = findXmlSelectorBracketEnd(selector, index)
      if (end !== undefined) {
        const body = selector.slice(index + 1, end)
        const attribute = /^\s*([A-Za-z_$][\w$:-]*)\s*~=\s*([\s\S]+?)\s*$/u.exec(body)
        if (attribute !== null) {
          const name = `legadoxmlattrregex${sequence++}`
          const attributeName = attribute[1]!
          const regex = xmlPseudoRegex(attribute[2]!)
          dynamic[name] = (element) => {
            const value = attributeValue(element, attributeName)
            if (value === undefined) return false
            regex.lastIndex = 0
            return regex.test(value)
          }
          output += `:${name}`
          index = end + 1
          continue
        }
        output += selector.slice(index, end + 1)
        index = end + 1
        continue
      }
    }
    output += selector[index]!
    index += 1
  }
  return { selector: output, pseudos: { ...xmlPseudos, ...dynamic } }
}

function findXmlSelectorBracketEnd(selector: string, start: number): number | undefined {
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let nested = 0
  for (let index = start + 1; index < selector.length; index += 1) {
    const current = selector[index]!
    if (escaped) { escaped = false; continue }
    if (current === '\\') { escaped = true; continue }
    if (quote !== null) {
      if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'") { quote = current === '"' ? 'double' : 'single'; continue }
    if (current === '[') { nested += 1; continue }
    if (current === ']') {
      if (nested > 0) nested -= 1
      else return index
    }
  }
  return undefined
}

export class XPathParserAdapter implements XPathParser {
  public parse(input: string): XmlDocumentView {
    // Android's XPath parser uses Jsoup for HTML and XML only for an XML declaration.
    // Repair ordinary HTML first so unclosed tags, void elements, and unquoted
    // attributes do not make an otherwise useful XPath document disappear.
    let source = input
    if (!/^\s*<\?xml\b/i.test(source)) {
      if (source.endsWith('</td>')) source = `<tr>${source}</tr>`
      if (source.endsWith('</tr>') || source.endsWith('</tbody>')) source = `<table>${source}</table>`
    }
    const normalized = /^\s*<\?xml\b/i.test(source)
      ? source
      : render(parseDocument(source), { xmlMode: true, encodeEntities: true })
    return new XmlDocumentView(new DOMParser({ onError: () => undefined }).parseFromString(normalized, 'text/xml') as unknown as XmlNode)
  }

  public evaluate(document: HtmlDocument, expression: string): RuleValue | ParserNode[] | null {
    if (!(document instanceof XmlDocumentView)) throw new Error('XPath requires an XML document created by XPathParserAdapter.parse')
    const result = evaluateXPath(expression, document.context(), undefined, undefined, ReturnType.ALL_RESULTS) as unknown[]
    if (result.every(isXmlNode)) return result.map((item) => document.wrap(item))
    if (result.length === 1) return normalizeXPathValue(result[0])
    return result.map(normalizeXPathValue)
  }

  public context(document: HtmlDocument, node: ParserNode): HtmlDocument {
    if (document instanceof XmlDocumentView) return document.child(node)
    const fragment = this.parse(document.read(node, 'all'))
    const root = fragment.children()[0]
    return root === undefined ? fragment : fragment.child(root)
  }
}

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && 'nodeType' in value
}

function normalizeXPathValue(value: unknown): RuleValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(normalizeXPathValue)
  if (isXmlNode(value)) return value.textContent ?? value.nodeValue ?? ''
  return String(value)
}

function childNodes(value: XmlNode): XmlNode[] {
  const children: XmlNode[] = []
  for (let index = 0; index < (value.childNodes?.length ?? 0); index += 1) {
    const child = value.childNodes?.item(index)
    if (child !== null && child !== undefined) children.push(child)
  }
  return children
}

function attributeValue(node: XmlNode, name: string): string | undefined {
  for (let index = 0; index < (node.attributes?.length ?? 0); index += 1) {
    const attribute = node.attributes?.item(index)
    if (attribute?.name === name) return attribute.value
  }
  return undefined
}

function isAncestor(ancestor: XmlNode, node: XmlNode): boolean {
  let current = node.parentNode
  while (current !== null && current !== undefined) {
    if (current === ancestor) return true
    current = current.parentNode
  }
  return false
}
