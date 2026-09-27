import { parseDocument } from 'htmlparser2'
import { isDocument, isText, isTag, type AnyNode } from 'domhandler'
import { getAttributeValue, getChildren, getText, textContent } from 'domutils'
import { selectAll } from 'css-select'
import { render } from 'dom-serializer'
import type { HtmlDocument, HtmlParser, ParserNode } from '@legado/source-core'

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
    return selectAll(selector, this.root).map((node) => this.wrap(node))
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
    if (output === 'text') return textContent(value)
    const children = isDocument(value) || isTag(value) ? getChildren(value) : []
    if (output === 'textNodes') return children.filter(isText).map((child) => trimAndroidWhitespace(getText(child))).filter(Boolean).join('\n')
    return children.filter(isText).map((child) => getText(child)).filter(Boolean).join('')
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
