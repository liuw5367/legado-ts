import { DOMParser } from '@xmldom/xmldom'
import fontoxpath from 'fontoxpath'
import { parseDocument } from 'htmlparser2'
import { render } from 'dom-serializer'
import type { HtmlDocument, ParserNode, RuleValue, XPathParser } from '@legado/source-core'

const { evaluateXPath, ReturnType } = fontoxpath

type XmlNode = {
  nodeType: number
  nodeName?: string
  nodeValue?: string | null
  textContent?: string | null
  childNodes?: { length: number; item(index: number): XmlNode | null }
  attributes?: { length: number; item(index: number): { name: string; value: string } | null }
  toString?: () => string
}

class XmlDocumentView implements HtmlDocument {
  private readonly ids = new Map<string, XmlNode>()
  private readonly reverse = new WeakMap<object, string>()
  private nextId = 0
  private readonly root: XmlNode

  public constructor(root: XmlNode) {
    this.root = root
  }

  public select(_selector: string): ParserNode[] {
    return []
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
    if (output === 'text') return value.textContent ?? value.nodeValue ?? ''
    const children = childNodes(value)
    if (output === 'textNodes') return children.filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => trimAndroidWhitespace(child.nodeValue ?? '')).filter(Boolean).join('\n')
    if (output === 'ownText') return children.filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').filter(Boolean).join('')
    if (output === 'html') return children.map((child) => child.toString?.() ?? '').join('')
    return value.toString?.() ?? ''
  }

  public child(node: ParserNode): HtmlDocument {
    return new XmlDocumentView(this.node(node))
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

export class XPathParserAdapter implements XPathParser {
  public parse(input: string): XmlDocumentView {
    // Android's XPath parser uses Jsoup for HTML and XML only for an XML declaration.
    // Repair ordinary HTML first so unclosed tags, void elements, and unquoted
    // attributes do not make an otherwise useful XPath document disappear.
    const source = /^\s*<\?xml\b/i.test(input)
      ? input
      : render(parseDocument(input), { xmlMode: true, encodeEntities: true })
    return new XmlDocumentView(new DOMParser({ onError: () => undefined }).parseFromString(source, 'text/xml') as unknown as XmlNode)
  }

  public evaluate(document: HtmlDocument, expression: string): RuleValue | ParserNode[] | null {
    if (!(document instanceof XmlDocumentView)) throw new Error('XPath requires an XML document created by XPathParserAdapter.parse')
    const result = evaluateXPath(expression, document.context(), undefined, undefined, ReturnType.ALL_RESULTS) as unknown[]
    if (result.every(isXmlNode)) return result.map((item) => document.wrap(item))
    if (result.length === 1) return normalizeXPathValue(result[0])
    return result.map(normalizeXPathValue)
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
