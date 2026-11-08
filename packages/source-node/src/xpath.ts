import { DOMParser } from '@xmldom/xmldom'
import { is as matchesSelector, selectAll } from 'css-select'
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
  private readonly matchTextMeta = new WeakMap<object, { owner: XmlNode; text: XmlNode }>()
  private readonly matchTextParents = new WeakMap<object, XmlNode>()
  private nextId = 0
  private readonly root: XmlNode
  private readonly xml: boolean

  public constructor(root: XmlNode, xml: boolean) {
    this.root = root
    this.xml = xml
  }

  public select(selector: string): ParserNode[] {
    try {
      const normalized = normalizeXmlSelector(selector)
      if (!normalized.matchTextTopLevel) {
        return selectAll<XmlNode, XmlNode>(normalized.selector, this.root, { adapter: cssAdapter, xmlMode: true, pseudos: normalized.pseudos }).map((node) => this.wrap(node))
      }
      const split = splitTopLevelMatchText(selector)
      if (split === undefined) throw new ParserAdapterError('unsupported-selector', ':matchText 复杂组合选择器暂不受支持')
      const ownerSelector = split.prefix.trim() || '*'
      const ownerNormalized = normalizeXmlSelector(ownerSelector)
      if (ownerNormalized.matchTextTopLevel) throw new ParserAdapterError('unsupported-selector', ':matchText 不能重复出现在同一选择器分支')
      const owners = selectAll<XmlNode, XmlNode>(ownerNormalized.selector, this.root, { adapter: cssAdapter, xmlMode: true, pseudos: ownerNormalized.pseudos })
      const matched = this.matchTextNodes(owners)
      const suffix = split.suffix.trim()
      if (suffix.length === 0) return matched
      const suffixNormalized = normalizeXmlSelector(suffix)
      if (suffixNormalized.matchTextTopLevel) throw new ParserAdapterError('unsupported-selector', ':matchText 不能嵌套在同一选择器分支')
      return matched.filter((node) => matchesSelector(this.node(node), suffixNormalized.selector, { adapter: cssAdapter, xmlMode: true, pseudos: suffixNormalized.pseudos }))
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
    const matchText = this.matchTextMeta.get(value)
    if (matchText !== undefined && (output === 'html' || output === 'all')) return matchText.text.toString?.() ?? matchText.text.nodeValue ?? ''
    if (output === 'text') return normalizeXmlText(value.textContent ?? value.nodeValue ?? '')
    const children = childNodes(value)
    if (output === 'textNodes') return children.filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => normalizeXmlText(child.nodeValue ?? '')).filter(Boolean).join('\n')
    if (output === 'ownText') return normalizeXmlText(children.filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').join(''))
    if (output === 'html') return children.map((child) => child.toString?.() ?? '').join('')
    return value.toString?.() ?? ''
  }

  public child(node: ParserNode): HtmlDocument {
    return new XmlDocumentView(this.node(node), this.xml)
  }

  public stringify(node: ParserNode): string {
    const value = this.node(node)
    return value.nodeType === 1 ? serializeXPathElement(value, this.xml) : this.read(node, 'text')
  }

  public describe(node: ParserNode): ParserNodeInfo {
    const value = this.node(node)
    const matchText = this.matchTextMeta.get(value)
    const parent = matchText?.owner ?? value.parentNode ?? null
    const siblingParent = value.parentNode ?? null
    const elementSiblings = siblingParent === null ? [] : childNodes(siblingParent).filter((item) => item.nodeType === 1)
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
    if (value.nodeType === 3) info.tagName = 'JX_TEXT'
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
    const matchText = this.matchTextMeta.get(value)
    if (matchText !== undefined && mutation.operation === 'remove') {
      const parent = matchText.text.parentNode
      if (parent?.removeChild !== undefined) {
        parent.removeChild(matchText.text)
      } else if (parent?.childNodes !== undefined) {
        const children = childNodes(parent).filter((child) => child !== matchText.text)
        parent.childNodes = { length: children.length, item: (index: number) => children[index] ?? null }
      }
      const virtualParent = this.matchTextParents.get(matchText.owner)
      if (virtualParent?.childNodes !== undefined) {
        const children = childNodes(virtualParent).filter((child) => child !== value)
        virtualParent.childNodes = { length: children.length, item: (index: number) => children[index] ?? null }
      }
      return undefined
    }
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

  public namespaceResolver(): (prefix: string) => string | null {
    const namespaces = new Map<string, string | null>([['xml', 'http://www.w3.org/XML/1998/namespace']])
    const chain: XmlNode[] = []
    let current: XmlNode | null | undefined = this.root
    if (current?.nodeType === 9) current = childNodes(current).find((node) => node.nodeType === 1) ?? current
    while (current !== null && current !== undefined) {
      chain.push(current)
      current = current.parentNode
    }
    chain.reverse()
    for (const node of chain) {
      for (let index = 0; index < (node.attributes?.length ?? 0); index += 1) {
        const attribute = node.attributes?.item(index)
        if (attribute === null || attribute === undefined) continue
        if (attribute.name === 'xmlns') namespaces.set('', attribute.value || null)
        else if (attribute.name.startsWith('xmlns:')) namespaces.set(attribute.name.slice(6), attribute.value || null)
      }
    }
    return (prefix: string) => namespaces.get(prefix) ?? null
  }

  public wrap(value: XmlNode): ParserNode {
    const existing = this.reverse.get(value)
    if (existing !== undefined) return { id: existing, kind: parserNodeKind(value) }
    const id = `x${this.nextId++}`
    this.reverse.set(value, id)
    this.ids.set(id, value)
    return { id, kind: parserNodeKind(value) }
  }

  private matchTextParent(owner: XmlNode): XmlNode {
    // Mirror Jsoup's temporary TextNode replacement in a detached parent so
    // structural suffixes can traverse pseudo-element siblings safely.
    const existing = this.matchTextParents.get(owner)
    if (existing !== undefined) return existing
    const parent: XmlNode = {
      nodeType: owner.nodeType,
      nodeName: owner.nodeName ?? '',
      nodeValue: owner.nodeValue ?? null,
      textContent: owner.textContent ?? '',
      parentNode: owner.parentNode ?? null,
      ...(owner.attributes === undefined ? {} : { attributes: owner.attributes }),
    }
    const children = childNodes(owner).map((child) => {
      if (child.nodeType === 3 || child.nodeType === 4) return this.createMatchTextPseudo(owner, child, parent)
      const clone = child.cloneNode?.(true) ?? child
      clone.parentNode = parent
      return clone
    })
    parent.childNodes = { length: children.length, item: (index: number) => children[index] ?? null }
    this.matchTextParents.set(owner, parent)
    return parent
  }

  private createMatchTextPseudo(owner: XmlNode, text: XmlNode, parent: XmlNode): XmlNode {
    const textClone: XmlNode = {
      nodeType: text.nodeType,
      nodeValue: text.nodeValue ?? null,
      textContent: text.textContent ?? text.nodeValue ?? '',
      parentNode: null,
      childNodes: { length: 0, item: () => null },
      toString: () => text.toString?.() ?? text.nodeValue ?? '',
    }
    const pseudo: XmlNode = {
      nodeType: 1,
      nodeName: owner.nodeName ?? '',
      textContent: textClone.textContent ?? '',
      parentNode: parent,
      childNodes: { length: 1, item: (index: number) => index === 0 ? textClone : null },
      ...(owner.attributes === undefined ? {} : { attributes: owner.attributes }),
      setAttribute: (name, value) => owner.setAttribute?.(name, value),
      removeAttribute: (name) => owner.removeAttribute?.(name),
      toString: () => textClone.toString?.() ?? textClone.nodeValue ?? '',
    }
    textClone.parentNode = pseudo
    this.matchTextMeta.set(pseudo, { owner, text })
    return pseudo
  }

  private matchTextNodes(nodes: XmlNode[]): ParserNode[] {
    const selected = new Set(nodes)
    const matched: ParserNode[] = []
    const visit = (node: XmlNode): void => {
      for (const child of childNodes(node)) {
        if (node.nodeType === 1 && selected.has(node) && (child.nodeType === 3 || child.nodeType === 4)) {
          const parent = this.matchTextParent(node)
          const pseudo = childNodes(parent).find((item) => this.matchTextMeta.get(item)?.text === child)
          if (pseudo !== undefined) matched.push(this.wrap(pseudo))
        }
        if (child.nodeType === 1 || child.nodeType === 9) visit(child)
      }
    }
    visit(this.root)
    return matched
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
  const source = value ?? ''
  let start = 0
  let end = source.length
  while (start < end && source.charCodeAt(start) <= 0x20) start += 1
  while (end > start && source.charCodeAt(end - 1) <= 0x20) end -= 1
  const index = source.slice(start, end)
  if (index.length === 0 || [...index].some((character) => character < '0' || character > '9')) throw new Error(`invalid pseudo index: ${value ?? ''}`)
  const number = Number(index)
  if (!Number.isInteger(number) || number > 2_147_483_647) throw new Error(`invalid pseudo index: ${value ?? ''}`)
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

function xmlRegexMatches(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0
  return regex.test(value)
}

function xmlContainsValue(value: string | null | undefined): string {
  return normalizeXmlText(value ?? '').toLowerCase()
}

function xmlWholeOwnText(element: XmlNode): string {
  return childNodes(element)
    .filter((child) => child.nodeType === 3 || child.nodeType === 4)
    .map((child) => child.nodeValue ?? '')
    .join('')
}

function xmlWholeText(element: XmlNode): string {
  return element.textContent ?? element.nodeValue ?? ''
}

function xmlData(element: XmlNode): string {
  let output = ''
  const visit = (node: XmlNode): void => {
    if (node.nodeType === 4 || node.nodeType === 8) {
      output += node.nodeValue ?? ''
      return
    }
    for (const child of childNodes(node)) visit(child)
  }
  visit(element)
  return output
}

const xmlPseudos: Record<string, (element: XmlNode, value?: string | null) => boolean> = {
  // Jsoup CSS Index* only accepts a non-negative ASCII Int; negative indexes are selector errors.
  legadoeq: (element, value) => xmlSiblingIndex(element) === xmlPseudoNumber(value),
  legadolt: (element, value) => xmlSiblingIndex(element) < xmlPseudoNumber(value),
  legadogt: (element, value) => xmlSiblingIndex(element) > xmlPseudoNumber(value),
  legadocontainsown: (element, value) => {
    const own = childNodes(element).filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').join('')
    return xmlContainsValue(normalizeXmlText(own)).includes(xmlContainsValue(value))
  },
  legadocontains: (element, value) => xmlContainsValue(normalizeXmlText(element.textContent ?? '')).includes(xmlContainsValue(value)),
  legadocontainswholetext: (element, value) => xmlWholeText(element).includes(value ?? ''),
  legadocontainswholeowntext: (element, value) => xmlWholeOwnText(element).includes(value ?? ''),
  legadocontainsdata: (element, value) => xmlData(element).toLowerCase().includes((value ?? '').toLowerCase()),
  legadoblank: (element) => normalizeXmlText(xmlWholeOwnText(element)).length === 0,
  legadomatchtext: (element) => childNodes(element).some((child) => child.nodeType === 3 || child.nodeType === 4),
  legadomatchesown: (element, value) => {
    const own = childNodes(element).filter((child) => child.nodeType === 3 || child.nodeType === 4).map((child) => child.nodeValue ?? '').join('')
    return xmlRegexMatches(xmlPseudoRegex(value), normalizeXmlText(own))
  },
  legadomatches: (element, value) => xmlRegexMatches(xmlPseudoRegex(value), normalizeXmlText(element.textContent ?? '')),
  legadomatcheswholetext: (element, value) => xmlRegexMatches(xmlPseudoRegex(value), xmlWholeText(element)),
  legadomatcheswholeowntext: (element, value) => xmlRegexMatches(xmlPseudoRegex(value), xmlWholeOwnText(element)),
}

interface NormalizedXmlSelector {
  selector: string
  pseudos: Record<string, (element: XmlNode, value?: string | null) => boolean>
  matchTextTopLevel: boolean
}

function normalizeXmlSelector(selector: string): NormalizedXmlSelector {
  const dynamic: Record<string, (element: XmlNode, value?: string | null) => boolean> = {}
  let output = ''
  let index = 0
  let sequence = 0
  while (index < selector.length) {
    if (/^:matchText\b/iu.test(selector.slice(index))) {
      output += ':legadomatchtext'
      index += ':matchText'.length
      continue
    }
    const pseudo = /^:(containsWholeOwnText|containsWholeText|containsOwn|containsData|contains|matchesWholeOwnText|matchesWholeText|matchesOwn|matches|eq|lt|gt)\(/iu.exec(selector.slice(index))
    if (pseudo !== null) {
      output += `:legado${pseudo[1]!.toLowerCase()}(`
      const argumentStart = index + pseudo[0].length
      const argumentEnd = findXmlSelectorParenthesisEnd(selector, argumentStart - 1)
      if (argumentEnd !== undefined) {
        output += selector.slice(argumentStart, argumentEnd)
        output += ')'
        index = argumentEnd + 1
      } else {
        index = argumentStart
      }
      continue
    }
    if (/^:blank\b/iu.test(selector.slice(index))) {
      output += ':legadoblank'
      index += 6
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
  return { selector: output, pseudos: { ...xmlPseudos, ...dynamic }, matchTextTopLevel: hasTopLevelMatchText(selector) }
}

function hasTopLevelMatchText(selector: string): boolean {
  let bracketDepth = 0
  let parenthesisDepth = 0
  let quote: 'single' | 'double' | null = null
  let escaped = false
  for (let index = 0; index < selector.length; index += 1) {
    const current = selector[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'") {
      quote = current === '"' ? 'double' : 'single'
      continue
    }
    if (current === '[') {
      bracketDepth += 1
      continue
    }
    if (current === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }
    if (bracketDepth > 0) continue
    if (current === '(') {
      parenthesisDepth += 1
      continue
    }
    if (current === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1)
      continue
    }
    if (parenthesisDepth === 0 && /^:matchText\b/iu.test(selector.slice(index))) return true
  }
  return false
}

function splitTopLevelMatchText(selector: string): { prefix: string; suffix: string } | undefined {
  let bracketDepth = 0
  let parenthesisDepth = 0
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let start: number | undefined
  let end: number | undefined
  for (let index = 0; index < selector.length; index += 1) {
    const current = selector[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'") {
      quote = current === '"' ? 'double' : 'single'
      continue
    }
    if (current === '[') {
      bracketDepth += 1
      continue
    }
    if (current === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }
    if (bracketDepth > 0) continue
    if (current === '(') {
      parenthesisDepth += 1
      continue
    }
    if (current === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1)
      continue
    }
    if (parenthesisDepth !== 0) continue
    if (current === ',') return undefined
    if (/^:matchText\b/iu.test(selector.slice(index))) {
      if (start !== undefined) return undefined
      start = index
      end = index + ':matchText'.length
      index = end - 1
    }
  }
  if (start === undefined || end === undefined) return undefined
  if (/[\s>+~]/u.test(selector.slice(end).trimStart()[0] ?? '')) return undefined
  return { prefix: selector.slice(0, start), suffix: selector.slice(end) }
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

function findXmlSelectorParenthesisEnd(selector: string, start: number): number | undefined {
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let nested = 0
  let bracketDepth = 0
  for (let index = start + 1; index < selector.length; index += 1) {
    const current = selector[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (current === '\\') {
      escaped = true
      continue
    }
    if (quote !== null) {
      if (current === quote) quote = null
      continue
    }
    if (current === '"' || current === "'") {
      quote = current === '"' ? 'double' : 'single'
      continue
    }
    if (current === '(') {
      nested += 1
      continue
    }
    if (current === '[') {
      bracketDepth += 1
      continue
    }
    if (current === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      continue
    }
    if (current === ')') {
      if (bracketDepth > 0) continue
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
    const xml = /^\s*<\?xml\b/i.test(source)
    if (!xml) {
      if (source.endsWith('</td>')) source = `<tr>${source}</tr>`
      if (source.endsWith('</tr>') || source.endsWith('</tbody>')) source = `<table>${source}</table>`
    }
    const normalized = ensureXmlPrefixDeclarations(xml
      ? source
      : render(parseDocument(source, { recognizeSelfClosing: true }), { xmlMode: true, encodeEntities: true }))
    const parsed = new DOMParser({ onError: () => undefined }).parseFromString(normalized.source, 'text/xml') as unknown as XmlNode
    if (normalized.syntheticPrefixes.length > 0) {
      const root = parsed.nodeType === 9 ? childNodes(parsed).find((node) => node.nodeType === 1) : parsed
      for (const prefix of normalized.syntheticPrefixes) root?.removeAttribute?.(`xmlns:${prefix}`)
    }
    return new XmlDocumentView(parsed, xml)
  }

  public evaluate(document: HtmlDocument, expression: string): RuleValue | ParserNode[] | null {
    if (!(document instanceof XmlDocumentView)) throw new Error('XPath requires an XML document created by XPathParserAdapter.parse')
    if (expression.length === 0) return null
    const androidResult = evaluateAndroidXPathCompatibility(document, expression)
    if (androidResult !== undefined) return androidResult
    const result = evaluateXPath(expression, document.context(), undefined, undefined, ReturnType.ALL_RESULTS, { namespaceResolver: document.namespaceResolver() }) as unknown[]
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

  public stringify(document: HtmlDocument, node: ParserNode): string {
    if (!(document instanceof XmlDocumentView)) throw new Error('XPath requires an XML document created by XPathParserAdapter.parse')
    return document.stringify(node)
  }
}

function ensureXmlPrefixDeclarations(source: string): { source: string; syntheticPrefixes: string[] } {
  const prefixes = new Set([...source.matchAll(/<\/?([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*(?=[\s/>])/g)].map((match) => match[1]!))
  if (prefixes.size === 0) return { source, syntheticPrefixes: [] }
  for (const match of source.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=/g)) prefixes.delete(match[1]!)
  if (prefixes.size === 0) return { source, syntheticPrefixes: [] }

  const root = /<[A-Za-z_][\w:.-]*/g.exec(source)
  if (root === null) return { source, syntheticPrefixes: [] }
  let end = root.index + root[0].length
  let quote: '"' | "'" | undefined
  while (end < source.length) {
    const char = source[end]!
    if (quote === undefined && (char === '"' || char === "'")) quote = char
    else if (quote === char) quote = undefined
    else if (quote === undefined && char === '>') break
    end += 1
  }
  if (end >= source.length) return { source, syntheticPrefixes: [] }

  const insertAt = source[end - 1] === '/' ? end - 1 : end
  const syntheticPrefixes = [...prefixes]
  const declarations = syntheticPrefixes.map((prefix) => ` xmlns:${prefix}="urn:legado:unbound-prefix:${prefix}"`).join('')
  return { source: source.slice(0, insertAt) + declarations + source.slice(insertAt), syntheticPrefixes }
}

function evaluateAndroidXPathCompatibility(document: XmlDocumentView, expression: string): RuleValue | ParserNode[] | null | undefined {
  const masked = maskXPathLiterals(expression)
  const functions = [...masked.matchAll(/([A-Za-z_][\w.-]*)\s*\(/g)].map((match) => match[1]!.toLowerCase())
  const unsupportedFunction = functions.find((name) => name === 'local-name' || name === 'string')
  if (unsupportedFunction !== undefined) {
    return throwAndroidXPathSyntaxError(`NoSuchFunctionException: not support function: ${unsupportedFunction}`)
  }

  const qualifiedSteps = [...masked.matchAll(/\/{1,2}\s*([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)/g)].map((match) => match[1]!)
  if (functions.includes('count') && qualifiedSteps.length > 0) {
    return throwAndroidXPathSyntaxError('ClassCastException: class java.lang.String cannot be cast to class org.jsoup.select.Elements')
  }
  if (functions.includes('count') && /(?:^|\/)\s*@/.test(masked)) {
    return throwAndroidXPathSyntaxError('ClassCastException: class java.util.LinkedList cannot be cast to class org.jsoup.select.Elements')
  }

  const wildcardAttribute = /^\s*\/\/\s*\*\s*\/\s*@\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*$/.exec(masked)
  if (wildcardAttribute !== null) {
    const elements = evaluateXPath('//*', document.context(), undefined, undefined, ReturnType.ALL_RESULTS, { namespaceResolver: document.namespaceResolver() }) as unknown[]
    return elements.filter(isXmlNode).map((element) => attributeValue(element, wildcardAttribute[1]!) ?? '')
  }

  if (qualifiedSteps.length === 0) return undefined

  // JsoupXpath 2.5.3 does not bind XML prefixes to namespace URIs. Its parser
  // exposes the last prefixed step as a scalar; text() yields no JXNodes, while
  // attribute axes yield the empty scalar. Match that observable contract here.
  if (/\/(?:\s*)@/.test(masked)) return ''
  if (/\/\s*text\s*\(\s*\)\s*$/i.test(masked)) return []
  return qualifiedSteps.at(-1)!
}

function maskXPathLiterals(expression: string): string {
  let output = ''
  let quote: '"' | "'" | undefined
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!
    if (quote === undefined) {
      if (char === '"' || char === "'") {
        quote = char
        output += ' '
      } else output += char
      continue
    }
    output += ' '
    if (char === quote) {
      if (expression[index + 1] === quote) {
        output += ' '
        index += 1
      } else quote = undefined
    }
  }
  return output
}

function throwAndroidXPathSyntaxError(detail: string): never {
  const error = new Error(`Please check the syntax of your xpath expr or commit a Issue. ${detail}`)
  error.name = 'org.seimicrawler.xpath.exception.XpathSyntaxErrorException'
  throw error
}

function parserNodeKind(node: XmlNode): ParserNode['kind'] {
  if (node.nodeType === 2) return 'attribute'
  if (node.nodeType === 3) return 'text'
  if (node.nodeType === 9) return 'document'
  return 'element'
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

// 标签分组取自 XPath 参考端使用的 Jsoup 1.23.2 HTML TagSet。
const xpathBlockTags = new Set('html head body frameset script noscript style meta link title frame noframes section nav aside hgroup header footer p h1 h2 h3 h4 h5 h6 dialog search ul ol pre div blockquote hr address figure figcaption form fieldset dl dt dd li table caption thead tfoot tbody colgroup col tr th td details menu plaintext template article main center dir applet marquee listing br'.split(' '))
const xpathInlineTags = new Set('object base font tt i b u big small em strong dfn code samp kbd var cite abbr time acronym mark ruby rt rp rtc a img wbr map q sub sup bdo iframe embed span input select textarea label audio video canvas optgroup option legend datalist keygen output progress meter area param source track summary command device basefont bgsound menuitem data bdi s strike nobr ins del button picture slot rb'.split(' '))
const xpathInlineContainers = new Set('title p h1 h2 h3 h4 h5 h6 pre address li th td script style'.split(' '))
const xpathVoidTags = new Set('meta link base frame img br wbr embed hr input keygen col command device area basefont bgsound menuitem param source track'.split(' '))
const xpathPreserveSpace = new Set('pre plaintext title textarea script'.split(' '))

function serializeXPathElement(root: XmlNode, xml: boolean): string {
  const chunks: string[] = []
  const name = (node: XmlNode): string => node.nodeName ?? ''
  const isText = (node: XmlNode | undefined): boolean => node?.nodeType === 3
  // 仅折叠 HTML 空白，避免将不换行空格等正文字符归一化。
  const htmlSpace = /[\t\n\f\r ]+/gu
  const blankText = (node: XmlNode): boolean => isText(node) && (node.nodeValue ?? '').replace(htmlSpace, '').length === 0
  const block = (node: XmlNode | undefined): boolean => {
    if (node?.nodeType !== 1) return false
    if (xpathBlockTags.has(name(node))) return true
    if (xpathInlineTags.has(name(node)) || xpathVoidTags.has(name(node))) return false
    return node.parentNode?.nodeType === 9 || childNodes(node).filter((child) => child.nodeType === 1).slice(0, 5)
      .some((child) => xpathBlockTags.has(name(child)) || (!xpathInlineTags.has(name(child)) && !xpathVoidTags.has(name(child))))
  }
  const indent = (depth: number): void => { chunks.push('\n', ' '.repeat(Math.min(depth, 30))) }
  const visit = (node: XmlNode, depth: number, preserve: boolean): void => {
    if (node.nodeType !== 1) { chunks.push(node.toString?.() ?? ''); return }
    const tag = name(node)
    const children = childNodes(node)
    const head = node.cloneNode?.(false).toString?.().replace(/\/>$/u, '>') ?? `<${tag}>`
    if (xml && children.length === 0) { chunks.push(head.slice(0, -1), ' />'); return }
    chunks.push(head)
    if (!xml && xpathVoidTags.has(tag)) return
    const pretty = !xml && !preserve && !xpathPreserveSpace.has(tag)
    const blockParent = pretty && block(node)
    const breaksAtRuns = blockParent && !xpathInlineContainers.has(tag) && children.slice(0, 5).some((child) => !isText(child))
    const shouldBreak = (child: XmlNode, previous?: XmlNode): boolean => pretty && !blankText(child)
      && (block(child) || block(previous) || (breaksAtRuns && (previous === undefined || (previous.nodeType !== 1 && !isText(previous)))))
    let previous: XmlNode | undefined
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!
      const next = children[index + 1]
      const lineBreak = shouldBreak(child, previous)
      if (isText(child) && pretty) {
        let value = (child.nodeValue ?? '').replace(htmlSpace, ' ')
        if (blockParent) {
          if (index === 0 || block(children[index - 1]) || lineBreak) value = value.replace(/^ /u, '')
          if (next === undefined || (!isText(next) && shouldBreak(next, child))) value = value.replace(/ $/u, '')
        }
        if (lineBreak && blockParent && value.length > 0) indent(depth + 1)
        chunks.push(value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
      } else {
        if (lineBreak) indent(depth + 1)
        visit(child, depth + 1, !pretty)
      }
      if (!blankText(child)) previous = child
    }
    const first = children.find((child) => !blankText(child))
    if (first !== undefined && shouldBreak(first)) indent(depth)
    chunks.push(`</${tag}>`)
  }
  visit(root, 0, false)
  return chunks.join('')
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
