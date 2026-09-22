import wrapAnsi from 'wrap-ansi'
import { serializeContentBlock } from './content-format.ts'
import type { ContentBlockKind, FormattedContent } from './content-format.ts'

export interface ContentLayout {
  paragraphs: string[]
  lines: string[]
  /** One semantic kind per rendered line; blank paragraph separators are undefined. */
  lineKinds?: Array<ContentBlockKind | undefined>
}

/** Remove terminal control sequences before untrusted source text reaches Ink. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001B\](?:[^\u0007\u001B]|\u001B(?!\\))*?(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/gu, '�')
}

export function layoutContent(value: string, width: number): ContentLayout {
  const safeWidth = Math.max(8, width)
  const paragraphs = value.replace(/\r\n?/gu, '\n').split(/\n{2,}/gu).map((item) => item.trim()).filter(Boolean)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const wrapped = wrapAnsi(paragraph, safeWidth, { hard: true, trim: false, wordWrap: false })
    lines.push(...wrapped.split('\n'), '')
  }
  if (lines.at(-1) === '') lines.pop()
  return { paragraphs, lines }
}

/** Layout structured chapter blocks without losing block identity or preformatted whitespace. */
export function layoutFormattedContent(content: FormattedContent, width: number): ContentLayout {
  const safeWidth = Math.max(8, width)
  const blocks = content.blocks.map((block) => {
    const serialized = sanitizeTerminalText(serializeContentBlock(block))
    return { kind: block.kind, text: block.kind === 'preformatted' ? serialized : serialized.trim() }
  }).filter((block) => block.kind === 'separator' || block.text.length > 0)
  const paragraphs = blocks.map((block) => block.text)
  const lines: string[] = []
  const lineKinds: Array<ContentBlockKind | undefined> = []
  for (const block of blocks) {
    const wrapped = wrapAnsi(block.text, safeWidth, { hard: true, trim: false, wordWrap: false }).split('\n')
    lines.push(...wrapped)
    lineKinds.push(...wrapped.map(() => block.kind))
    lines.push('')
    lineKinds.push(undefined)
  }
  if (lines.at(-1) === '') {
    lines.pop()
    lineKinds.pop()
  }
  return { paragraphs, lines, lineKinds }
}

export function paragraphOffsetAtLine(layout: ContentLayout, line: number, width = 80): { paragraphIndex: number; offset: number } {
  if (layout.paragraphs.length === 0) return { paragraphIndex: 0, offset: 0 }
  const clamped = Math.max(0, Math.min(Math.max(0, layout.lines.length - 1), line))
  let paragraphIndex = 0
  let remaining = clamped
  for (const paragraph of layout.paragraphs) {
    const paragraphLines = wrapAnsi(paragraph, Math.max(8, width), { hard: true, trim: false, wordWrap: false }).split('\n')
    if (remaining < paragraphLines.length) return { paragraphIndex, offset: paragraphLines.slice(0, remaining).reduce((sum, item) => sum + item.length, 0) }
    remaining -= paragraphLines.length + 1
    paragraphIndex += 1
  }
  const last = layout.paragraphs.at(-1) ?? ''
  return { paragraphIndex: Math.max(0, layout.paragraphs.length - 1), offset: last.length }
}

export function lineAtParagraphOffset(layout: ContentLayout, paragraphIndex: number, offset: number, width = 80): number {
  if (layout.paragraphs.length === 0) return 0
  const safeWidth = Math.max(8, width)
  const target = Math.max(0, Math.min(layout.paragraphs.length - 1, paragraphIndex))
  let line = 0
  for (let index = 0; index < target; index += 1) {
    const wrapped = wrapAnsi(layout.paragraphs[index]!, safeWidth, { hard: true, trim: false, wordWrap: false }).split('\n')
    line += wrapped.length + 1
  }
  const paragraph = layout.paragraphs[target]!
  const safeOffset = Math.max(0, Math.min(paragraph.length, offset))
  const prefix = paragraph.slice(0, safeOffset)
  const wrappedPrefix = wrapAnsi(prefix, safeWidth, { hard: true, trim: false, wordWrap: false }).split('\n')
  return line + Math.max(0, wrappedPrefix.length - 1)
}
