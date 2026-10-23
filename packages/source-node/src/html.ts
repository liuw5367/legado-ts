import { parseDocument } from 'htmlparser2'
import { Element, Text, isCDATA, isComment, isDocument, isText, isTag, type AnyNode } from 'domhandler'
import { getAttributeValue, getChildren, getText } from 'domutils'
import { is as matchesSelector, selectAll } from 'css-select'
import { render } from 'dom-serializer'
import { compileSourcePattern, ParserAdapterError, type HtmlDocument, type HtmlParser, type ParserNode, type ParserNodeInfo, type ParserNodeMutation } from '@legado/source-core'

class HtmlDocumentView implements HtmlDocument {
  private readonly ids = new Map<string, AnyNode>()
  private readonly reverse = new WeakMap<object, string>()
  private readonly matchTextMeta = new WeakMap<object, { owner: AnyNode; text: AnyNode }>()
  private readonly matchTextParents = new WeakMap<object, Element>()
  private nextId = 0
  private readonly root: AnyNode
  private readonly xmlMode: boolean

  public constructor(root: AnyNode, xmlMode = false) {
    this.root = root
    this.xmlMode = xmlMode
  }

  public select(selector: string): ParserNode[] {
    try {
      const normalized = normalizeHtmlSelector(selector)
      if (!normalized.matchTextTopLevel) {
        return selectAll(normalized.selector, this.root, { xmlMode: this.xmlMode, pseudos: normalized.pseudos }).map((node) => this.wrap(node))
      }
      const split = splitTopLevelMatchText(selector)
      if (split === undefined) throw new ParserAdapterError('unsupported-selector', ':matchText 复杂组合选择器暂不受支持')
      const ownerSelector = split.prefix.trim() || '*'
      const ownerNormalized = normalizeHtmlSelector(ownerSelector)
      if (ownerNormalized.matchTextTopLevel) throw new ParserAdapterError('unsupported-selector', ':matchText 不能重复出现在同一选择器分支')
      const owners = selectAll(ownerNormalized.selector, this.root, { xmlMode: this.xmlMode, pseudos: ownerNormalized.pseudos })
      const matched = this.matchTextNodes(owners)
      const suffix = split.suffix.trim()
      if (suffix.length === 0) return matched
      const suffixNormalized = normalizeHtmlSelector(suffix)
      if (suffixNormalized.matchTextTopLevel) throw new ParserAdapterError('unsupported-selector', ':matchText 不能嵌套在同一选择器分支')
      return matched.filter((node) => matchesSelector(this.node(node), suffixNormalized.selector, { xmlMode: this.xmlMode, pseudos: suffixNormalized.pseudos }))
    } catch (error) {
      if (error instanceof ParserAdapterError) throw error
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
    const matchText = this.matchTextMeta.get(value)
    if (matchText !== undefined && (output === 'html' || output === 'all')) return render(matchText.text, { xmlMode: this.xmlMode, encodeEntities: false })
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
    if (output === 'textNodes') return children.filter((child) => (isText(child) || isCDATA(child)) && !isScriptOrStyle(child.parent)).map((child) => trimAndroidWhitespace(normalizeWhitespace(getText(child)))).filter(Boolean).join('\n')
    return ownTextValue(value)
  }

  public child(node: ParserNode): HtmlDocument {
    return new HtmlDocumentView(this.node(node), this.xmlMode)
  }

  public describe(node: ParserNode): ParserNodeInfo {
    const value = this.node(node)
    const matchText = this.matchTextMeta.get(value)
    const parent = matchText?.owner ?? value.parent
    const siblingParent = value.parent
    const elementSiblings = siblingParent === null ? [] : getChildren(siblingParent).filter(isTag)
    const siblingIndex = elementSiblings.indexOf(value as never)
    const parents: ParserNode[] = []
    let current = parent
    while (current !== null && current !== undefined) {
      parents.push(this.wrap(current))
      current = current.parent
    }
    const info: ParserNodeInfo = {
      parent: parent === null ? null : this.wrap(parent),
      parents,
      children: (isDocument(value) || isTag(value)) ? getChildren(value).filter(isTag).map((child) => this.wrap(child)) : [],
      previousSibling: siblingIndex > 0 ? this.wrap(elementSiblings[siblingIndex - 1]!) : null,
      nextSibling: siblingIndex >= 0 && siblingIndex + 1 < elementSiblings.length ? this.wrap(elementSiblings[siblingIndex + 1]!) : null,
    }
    if (isTag(value)) {
      info.tagName = value.name
      info.id = getAttributeValue(value, 'id') ?? ''
      info.className = getAttributeValue(value, 'class') ?? ''
      info.attributes = { ...(value.attribs ?? {}) }
    }
    return info
  }

  public mutate(node: ParserNode, mutation: ParserNodeMutation): ParserNode | undefined {
    const value = this.node(node)
    const matchText = this.matchTextMeta.get(value)
    if (matchText !== undefined && mutation.operation === 'remove') {
      const parent = matchText.text.parent
      if (parent !== null) {
        parent.children = parent.children.filter((child) => child !== matchText.text)
        relinkChildren(parent)
      }
      const virtualParent = this.matchTextParents.get(matchText.owner)
      if (virtualParent !== undefined) {
        virtualParent.children = virtualParent.children.filter((child) => child !== value)
        relinkChildren(virtualParent)
      }
      return undefined
    }
    if (mutation.operation === 'clone') return this.wrap(value.cloneNode(true))
    if (mutation.operation === 'remove') {
      const parent = value.parent
      if (parent !== null) {
        parent.children = parent.children.filter((child) => child !== value)
        relinkChildren(parent)
      }
      return undefined
    }
    if (!isTag(value)) return undefined
    const name = mutation.name
    if (mutation.value === null || mutation.value === undefined) delete value.attribs[name]
    else value.attribs[name] = mutation.value
    return undefined
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

  private matchTextParent(owner: AnyNode): Element {
    // Jsoup temporarily replaces direct TextNodes in the real parent. Keep a
    // detached clone instead so structural suffixes can inspect sibling links
    // without mutating the document seen by later rules.
    const existing = this.matchTextParents.get(owner)
    if (existing !== undefined) return existing
    const parent = new Element(isTag(owner) ? owner.name : 'div', isTag(owner) ? (owner.attribs ?? {}) : {}, [])
    parent.parent = isTag(owner) ? owner.parent : null
    const children = getChildren(owner).map((child) => {
      if (isText(child)) {
        const pseudo = new Element(isTag(owner) ? owner.name : 'div', isTag(owner) ? (owner.attribs ?? {}) : {}, [new Text(getText(child))])
        pseudo.parent = parent
        this.matchTextMeta.set(pseudo, { owner, text: child })
        return pseudo
      }
      const clone = child.cloneNode(true)
      clone.parent = parent
      return clone
    })
    parent.children = children
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!
      child.prev = children[index - 1] ?? null
      child.next = children[index + 1] ?? null
    }
    this.matchTextParents.set(owner, parent)
    return parent
  }

  private matchTextNodes(nodes: AnyNode[]): ParserNode[] {
    const selected = new Set(nodes)
    const matched: ParserNode[] = []
    const visit = (node: AnyNode): void => {
      if (!isDocument(node) && !isTag(node)) return
      for (const child of getChildren(node)) {
        if (isTag(node) && selected.has(node) && isText(child) && !isScriptOrStyle(child.parent)) {
          const parent = this.matchTextParent(node)
          const pseudo = getChildren(parent).find((item) => this.matchTextMeta.get(item)?.text === child)
          if (pseudo !== undefined) matched.push(this.wrap(pseudo))
        }
        if (isDocument(child) || isTag(child)) visit(child)
      }
    }
    visit(this.root)
    return matched
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
  const append = (value: string, preserve = false): void => { if (value.length > 0) chunks.push(preserve ? value : normalizeWhitespace(value)) }
  const visit = (current: AnyNode): void => {
    if (isScriptOrStyle(current)) return
    if (isText(current) || isCDATA(current)) {
      append(getText(current), isCDATA(current) || preservesWhitespace(current.parent))
      return
    }
    if (!isDocument(current) && isTag(current) && blockElements.has(current.name)) append(' ')
    for (const child of getChildren(current)) visit(child)
    if (!isDocument(current) && isTag(current) && blockElements.has(current.name)) append(' ')
  }
  visit(node)
  return chunks.join('').replace(/[ \t\f\v\r]+/gu, ' ').trim()
}

function ownTextValue(node: AnyNode): string {
  if (!isDocument(node) && !isTag(node)) return ''
  let output = ''
  for (const child of getChildren(node)) {
    if (isText(child) || isCDATA(child)) {
      if (isScriptOrStyle(child.parent)) continue
      const text = getText(child)
      output += isCDATA(child) || preservesWhitespace(child.parent) ? text : normalizeWhitespace(text)
      continue
    }
    if (isTag(child) && child.name === 'br' && !output.endsWith(' ')) output += ' '
  }
  return trimAndroidWhitespace(output)
}

/** Jsoup wholeText 保留文本节点中的原始空白，但不把 script/style 的 DataNode 当正文。 */
function wholeTextValue(node: AnyNode): string {
  if (!isDocument(node) && !isTag(node)) return ''
  let output = ''
  const visit = (current: AnyNode): void => {
    if (isScriptOrStyle(current)) return
    if (isText(current) || isCDATA(current)) {
      output += getText(current)
      return
    }
    if (isDocument(current) || isTag(current)) for (const child of getChildren(current)) visit(child)
  }
  visit(node)
  return output
}

/** Jsoup wholeOwnText 只拼接当前元素的直接文本节点，保留原始空白。 */
function wholeOwnTextValue(node: AnyNode): string {
  if (!isDocument(node) && !isTag(node)) return ''
  return getChildren(node)
    .filter((child) => (isText(child) || isCDATA(child)) && !isScriptOrStyle(child.parent))
    .map((child) => getText(child))
    .join('')
}

/** Jsoup Element.data() 收集 script/style DataNode 及注释内容，不包含普通正文。 */
function dataValue(node: AnyNode): string {
  if (!isDocument(node) && !isTag(node)) return ''
  let output = ''
  const visit = (current: AnyNode): void => {
    if (isComment(current) || isCDATA(current) || (isText(current) && isScriptOrStyle(current.parent))) {
      output += 'data' in current ? String(current.data) : getText(current)
      return
    }
    if (isDocument(current) || isTag(current)) for (const child of getChildren(current)) visit(child)
  }
  visit(node)
  return output
}

function preservesWhitespace(node: AnyNode | null | undefined): boolean {
  let current = node
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
    if (isTag(current) && (current.name === 'pre' || current.name === 'textarea' || current.name === 'script')) return true
    current = current.parent
  }
  return false
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
  let source = (value ?? '').trim()
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/u.exec(source)
  if (quoted !== null) source = quoted[1] ?? quoted[2] ?? ''
  const literal = /^\/((?:\\.|[^/\\])*)\/([dgimsuvy]*)$/su.exec(source)
  const compiled = literal === null
    ? compileSourcePattern(source)
    : compileSourcePattern(literal[1]!, { flags: literal[2] ?? '' })
  if ('error' in compiled) throw new ParserAdapterError('unsupported-selector', `CSS 文本正则不受支持：${compiled.error.message}`)
  return compiled.regex
}

function regexMatches(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0
  return regex.test(value)
}

function normalizeContainsValue(value: string | null | undefined): string {
  return normalizeWhitespace(value ?? '').toLowerCase()
}

const htmlPseudos: Record<string, (element: AnyNode, value?: string | null) => boolean> = {
  // Jsoup 的 eq/lt/gt 使用元素在同级元素中的 0 基索引，不使用筛选结果集合索引。
  // Jsoup 不把负数转换为“倒数索引”；负数只会产生自然的空/全匹配结果。
  eq: (element, value) => elementSiblingIndex(element) === pseudoNumber(value),
  lt: (element, value) => elementSiblingIndex(element) < pseudoNumber(value),
  gt: (element, value) => elementSiblingIndex(element) > pseudoNumber(value),
  // Jsoup normalises the search text, then compares both sides case-insensitively.
  // The source rule syntax relies on this for mixed-case labels and folded whitespace.
  // Jsoup 的 :contains/:containsOwn 会归一化查询空白并忽略大小写。
  legadocontains: (element, value) => normalizeContainsValue(jsoupText(element)).includes(normalizeContainsValue(value)),
  legadocontainsown: (element, value) => normalizeContainsValue(ownTextValue(element)).includes(normalizeContainsValue(value)),
  legadocontainswholetext: (element, value) => wholeTextValue(element).includes(value ?? ''),
  legadocontainswholeowntext: (element, value) => wholeOwnTextValue(element).includes(value ?? ''),
  legadocontainsdata: (element, value) => dataValue(element).toLowerCase().includes((value ?? '').toLowerCase()),
  // Jsoup :blank 只检查当前元素的直接文本；子元素本身不使父元素变为非空。
  legadoblank: (element) => normalizeWhitespace(wholeOwnTextValue(element)).trim().length === 0,
  // Jsoup :matchText 将每个直接 TextNode 替换为一个只含该节点的伪元素。
  legadomatchtext: (element) => isTag(element) && getChildren(element).some((child) => isText(child) && !isScriptOrStyle(child.parent)),
  legadomatchesown: (element, value) => regexMatches(pseudoRegex(value), ownTextValue(element)),
  legadomatches: (element, value) => regexMatches(pseudoRegex(value), jsoupText(element)),
  legadomatcheswholetext: (element, value) => regexMatches(pseudoRegex(value), wholeTextValue(element)),
  legadomatcheswholeowntext: (element, value) => regexMatches(pseudoRegex(value), wholeOwnTextValue(element)),
}

interface NormalizedHtmlSelector {
  selector: string
  pseudos: Record<string, (element: AnyNode, value?: string | null) => boolean>
  matchTextTopLevel: boolean
}

/** 将 Jsoup 的文本正则和属性正则转换成 css-select 可安全执行的自定义伪类。 */
function normalizeHtmlSelector(selector: string): NormalizedHtmlSelector {
  const dynamic: Record<string, (element: AnyNode, value?: string | null) => boolean> = {}
  let output = ''
  let index = 0
  let sequence = 0
  while (index < selector.length) {
    if (/^:matchText\b/iu.test(selector.slice(index))) {
      output += ':legadomatchtext'
      index += ':matchText'.length
      continue
    }
    const pseudo = /^:(containsWholeOwnText|containsWholeText|containsOwn|containsData|contains|matchesWholeOwnText|matchesWholeText|matchesOwn|matches)\(/iu.exec(selector.slice(index))
    if (pseudo !== null) {
      output += `:legado${pseudo[1]!.toLowerCase()}(`
      const argumentStart = index + pseudo[0].length
      const argumentEnd = findSelectorParenthesisEnd(selector, argumentStart - 1)
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
      const end = findSelectorBracketEnd(selector, index)
      if (end !== undefined) {
        const body = selector.slice(index + 1, end)
        const attribute = /^\s*([A-Za-z_$][\w$:-]*)\s*~=\s*([\s\S]+?)\s*$/u.exec(body)
        if (attribute !== null) {
          const name = `legadoattrregex${sequence++}`
          const attributeName = attribute[1]!
          const regex = compileSelectorRegex(attribute[2]!)
          dynamic[name] = (element) => {
            if (!isTag(element)) return false
            const value = getAttributeValue(element, attributeName)
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
  return { selector: output, pseudos: { ...htmlPseudos, ...dynamic }, matchTextTopLevel: hasTopLevelMatchText(selector) }
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

function findSelectorBracketEnd(selector: string, start: number): number | undefined {
  let quote: 'single' | 'double' | null = null
  let escaped = false
  let nested = 0
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
    if (current === '[') {
      nested += 1
      continue
    }
    if (current === ']') {
      if (nested > 0) nested -= 1
      else return index
    }
  }
  return undefined
}

function findSelectorParenthesisEnd(selector: string, start: number): number | undefined {
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

function compileSelectorRegex(value: string): RegExp {
  let source = value.trim()
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/u.exec(source)
  if (quoted !== null) source = quoted[1] ?? quoted[2] ?? ''
  const literal = /^\/((?:\\.|[^/\\])*)\/([dgimsuvy]*)$/su.exec(source)
  const compiled = literal === null
    ? compileSourcePattern(source)
    : compileSourcePattern(literal[1]!, { flags: literal[2] ?? '' })
  if ('error' in compiled) throw new ParserAdapterError('unsupported-selector', `CSS 属性正则不受支持：${compiled.error.message}`)
  return compiled.regex
}

function removeScriptAndStyle(node: AnyNode): void {
  if (!isDocument(node) && !isTag(node)) return
  node.children = node.children.filter((child) => {
    if (isTag(child) && (child.name === 'script' || child.name === 'style')) return false
    removeScriptAndStyle(child)
    return true
  })
}

function relinkChildren(parent: AnyNode): void {
  const children = getChildren(parent)
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!
    child.prev = children[index - 1] ?? null
    child.next = children[index + 1] ?? null
  }
}

export class HtmlParserAdapter implements HtmlParser {
  public parse(input: string, mode: 'html' | 'xml' = 'html'): HtmlDocument {
    return new HtmlDocumentView(parseDocument(input, { xmlMode: mode === 'xml' }), mode === 'xml')
  }
}
