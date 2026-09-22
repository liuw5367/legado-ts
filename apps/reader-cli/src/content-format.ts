import { parseDocument } from 'htmlparser2'
import { isTag, isText } from 'domhandler'
import type { ChildNode, Node } from 'domhandler'

export type ContentBlockKind = 'paragraph' | 'heading' | 'quote' | 'list-item' | 'preformatted' | 'separator' | 'image-placeholder'

export interface ContentBlock {
  kind: ContentBlockKind
  text: string
  level?: number
  orderedIndex?: number
}

export interface FormattedContent {
  blocks: ContentBlock[]
  /** Terminal-safe semantic text used by the existing layout and anchors. */
  text: string
}

const BLOCK_TAGS = new Set(['article', 'aside', 'body', 'dd', 'div', 'dl', 'dt', 'figure', 'figcaption', 'footer', 'header', 'html', 'main', 'nav', 'p', 'section'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const MAX_DEPTH = 128
const MAX_NODES = 10000

/** Convert text or source HTML into terminal-readable semantic blocks. */
export function formatChapterContent(value: string, contentType: 'text' | 'html'): FormattedContent {
  if (contentType === 'text') return fromPlainText(value)
  const blocks: ContentBlock[] = []
  let visited = 0
  const document = parseDocument(value, { decodeEntities: true, lowerCaseTags: true })

  const append = (block: ContentBlock): void => {
    const normalized = block.text.replace(/\r\n?/gu, '\n')
    const text = block.kind === 'preformatted' ? normalized : normalized.trimEnd()
    if (block.kind !== 'separator' && text.trim().length === 0) return
    blocks.push({ ...block, text })
  }

  const inlineText = (node: Node, preserveWhitespace = false, depth = 0): string => {
    if (depth > MAX_DEPTH || visited++ > MAX_NODES) return ''
    if (isText(node)) return preserveWhitespace ? node.data : collapseInlineWhitespace(node.data)
    if (!isTag(node)) return ''
    const tag = node.name.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'template') return ''
    if (tag === 'br') return '\n'
    if (tag === 'img' || tag === 'image') {
      const alt = node.attribs.alt?.trim()
      return alt === undefined || alt.length === 0 ? '[图片]' : `[图片：${alt}]`
    }
    return node.children.map((child) => inlineText(child, preserveWhitespace, depth + 1)).join('')
  }

  const walk = (node: ChildNode, context: { listLevel: number; ordered: boolean; orderedIndex: number } = { listLevel: 0, ordered: false, orderedIndex: 0 }, depth = 0): void => {
    if (depth > MAX_DEPTH || visited++ > MAX_NODES) return
    if (!isTag(node)) return
    const tag = node.name.toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'template') return
    if (tag === 'hr') { append({ kind: 'separator', text: '────' }); return }
    if (tag === 'img' || tag === 'image') {
      append({ kind: 'image-placeholder', text: inlineText(node, false, depth) })
      return
    }
    if (HEADING_TAGS.has(tag)) {
      append({ kind: 'heading', text: inlineText(node), level: Number(tag.slice(1)) })
      return
    }
    if (tag === 'pre') {
      append({ kind: 'preformatted', text: inlineText(node, true, depth) })
      return
    }
    if (tag === 'blockquote') {
      append({ kind: 'quote', text: inlineText(node) })
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      let itemIndex = 0
      for (const child of node.children) {
        if (isTag(child) && child.name.toLowerCase() === 'li') {
          itemIndex += 1
          walk(child, { listLevel: context.listLevel + 1, ordered: tag === 'ol', orderedIndex: itemIndex }, depth + 1)
        } else if (isTag(child)) {
          walk(child, { listLevel: context.listLevel + 1, ordered: tag === 'ol', orderedIndex: itemIndex }, depth + 1)
        }
      }
      return
    }
    if (tag === 'li') {
      const indent = '  '.repeat(Math.max(0, context.listLevel - 1))
      const marker = context.ordered ? `${context.orderedIndex}. ` : '• '
      const nestedLists = node.children.filter((child) => isTag(child) && (child.name.toLowerCase() === 'ul' || child.name.toLowerCase() === 'ol'))
      const ownText = node.children.filter((child) => !isTag(child) || (child.name.toLowerCase() !== 'ul' && child.name.toLowerCase() !== 'ol')).map((child) => inlineText(child)).join('')
      append({ kind: 'list-item', text: `${indent}${marker}${ownText}`, level: context.listLevel, orderedIndex: context.orderedIndex })
      for (const nested of nestedLists) walk(nested, context, depth + 1)
      return
    }
    if (tag === 'br') { append({ kind: 'paragraph', text: '' }); return }
    if (BLOCK_TAGS.has(tag)) {
      const hasBlockChild = node.children.some((child) => isTag(child) && isBlockTag(child.name.toLowerCase()))
      if (hasBlockChild) {
        let inline = ''
        const flushInline = (): void => {
          if (inline.trim().length > 0) append({ kind: 'paragraph', text: inline })
          inline = ''
        }
        for (const child of node.children) {
          if (isTag(child) && isBlockTag(child.name.toLowerCase())) {
            flushInline()
            walk(child, context, depth + 1)
          } else {
            inline += inlineText(child)
          }
        }
        flushInline()
      } else {
        append({ kind: 'paragraph', text: inlineText(node) })
      }
      return
    }
    const text = inlineText(node)
    if (text.trim().length > 0) append({ kind: 'paragraph', text })
  }

  for (const node of document.children) {
    if (isTag(node)) walk(node)
    else if (node.type === 'text' && node.data.trim().length > 0) append({ kind: 'paragraph', text: collapseInlineWhitespace(node.data) })
  }
  if (visited > MAX_NODES) append({ kind: 'paragraph', text: '[正文过长，后续结构已省略]' })
  return toFormattedContent(blocks)
}

function fromPlainText(value: string): FormattedContent {
  const blocks = value.replace(/\r\n?/gu, '\n').split(/\n{2,}/gu).map((text) => text.trim()).filter(Boolean).map((text) => ({ kind: 'paragraph' as const, text }))
  return toFormattedContent(blocks)
}

function toFormattedContent(blocks: ContentBlock[]): FormattedContent {
  const text = blocks.map((block) => serializeBlock(block)).join('\n\n')
  return { blocks, text }
}

function serializeBlock(block: ContentBlock): string {
  if (block.kind === 'heading') return `${'#'.repeat(Math.max(1, Math.min(6, block.level ?? 1)))} ${block.text}`
  if (block.kind === 'quote') return block.text.split('\n').map((line) => `│ ${line.trim()}`).join('\n')
  if (block.kind === 'preformatted') return block.text
  if (block.kind === 'separator') return block.text
  return block.text
}

function isBlockTag(tag: string): boolean {
  return BLOCK_TAGS.has(tag) || HEADING_TAGS.has(tag) || tag === 'blockquote' || tag === 'pre' || tag === 'ul' || tag === 'ol' || tag === 'hr' || tag === 'li'
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/[\t\n\r \u00a0]+/gu, ' ')
}
