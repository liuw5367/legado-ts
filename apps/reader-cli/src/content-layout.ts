import { serializeContentBlock } from './content-format.ts'
import type { ContentBlockKind, FormattedContent } from './content-format.ts'
import { terminalWidth } from './ui-actions.ts'

export interface ContentLayout {
  paragraphs: string[]
  paragraphStarts: number[]
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
  const paragraphStarts: number[] = []
  for (const paragraph of paragraphs) {
    paragraphStarts.push(lines.length)
    lines.push(...wrapTerminalText(paragraph, safeWidth), '')
  }
  if (lines.at(-1) === '') lines.pop()
  return { paragraphs, paragraphStarts, lines }
}

/** Layout structured chapter blocks without losing block identity or preformatted whitespace. */
export function layoutFormattedContent(content: FormattedContent, width: number): ContentLayout {
  const safeWidth = Math.max(8, width)
  const blocks = content.blocks.map((block) => {
    const serialized = sanitizeTerminalText(serializeContentBlock(block))
    return { kind: block.kind, text: block.kind === 'preformatted' ? serialized : serialized.trim(), blankAfter: block.blankAfter }
  }).filter((block) => block.kind === 'separator' || block.text.length > 0)
  const paragraphs = blocks.map((block) => block.text)
  const lines: string[] = []
  const paragraphStarts: number[] = []
  const lineKinds: Array<ContentBlockKind | undefined> = []
  for (const [index, block] of blocks.entries()) {
    const wrapped = wrapTerminalText(block.text, safeWidth)
    paragraphStarts.push(lines.length)
    lines.push(...wrapped)
    lineKinds.push(...wrapped.map(() => block.kind))
    // HTML 书源常把每一行包成 p；逐段添加空行会让半屏文字被算成整页。
    if (index < blocks.length - 1 && (block.kind !== 'paragraph' || block.blankAfter === true)) {
      lines.push('')
      lineKinds.push(undefined)
    }
  }
  return { paragraphs, paragraphStarts, lines, lineKinds }
}

export function paragraphOffsetAtLine(layout: ContentLayout, line: number, width = 80): { paragraphIndex: number; offset: number } {
  if (layout.paragraphs.length === 0) return { paragraphIndex: 0, offset: 0 }
  const clamped = Math.max(0, Math.min(Math.max(0, layout.lines.length - 1), line))
  for (const [paragraphIndex, paragraph] of layout.paragraphs.entries()) {
    const start = layout.paragraphStarts[paragraphIndex] ?? 0
    const paragraphLines = wrapTerminalText(paragraph, Math.max(8, width))
    if (clamped < start + paragraphLines.length) return { paragraphIndex, offset: paragraphLines.slice(0, clamped - start).reduce((sum, item) => sum + item.length, 0) }
    const nextStart = layout.paragraphStarts[paragraphIndex + 1]
    if (nextStart !== undefined && clamped < nextStart) return { paragraphIndex: paragraphIndex + 1, offset: 0 }
  }
  const last = layout.paragraphs.at(-1) ?? ''
  return { paragraphIndex: Math.max(0, layout.paragraphs.length - 1), offset: last.length }
}

export function lineAtParagraphOffset(layout: ContentLayout, paragraphIndex: number, offset: number, width = 80): number {
  if (layout.paragraphs.length === 0) return 0
  const safeWidth = Math.max(8, width)
  const target = Math.max(0, Math.min(layout.paragraphs.length - 1, paragraphIndex))
  const paragraph = layout.paragraphs[target]!
  const safeOffset = Math.max(0, Math.min(paragraph.length, offset))
  const prefix = paragraph.slice(0, safeOffset)
  const wrappedPrefix = wrapTerminalText(prefix, safeWidth)
  return (layout.paragraphStarts[target] ?? 0) + Math.max(0, wrappedPrefix.length - 1)
}

/** Hard-wrap by terminal grapheme width and avoid starting a row with closing punctuation. */
function wrapTerminalText(value: string, width: number): string[] {
  const safeWidth = Math.max(8, width)
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (item) => item.segment)
  const lines: string[] = []
  let current: string[] = []
  let currentWidth = 0
  let endedWithNewline = false
  const finish = (): void => { lines.push(current.join('')); current = []; currentWidth = 0 }
  for (const segment of segments) {
    if (segment === '\n') { finish(); endedWithNewline = true; continue }
    endedWithNewline = false
    const segmentWidth = terminalWidth(segment)
    if (currentWidth + segmentWidth > safeWidth && current.length > 0) {
      if (/^[，。！？；：、）》」』】〕］｝…]/u.test(segment) && current.length > 1) {
        const moved = current.pop()!
        currentWidth -= terminalWidth(moved)
        finish()
        current = [moved, segment]
        currentWidth = terminalWidth(moved) + segmentWidth
      } else {
        finish()
        current = [segment]
        currentWidth = segmentWidth
      }
      continue
    }
    current.push(segment)
    currentWidth += segmentWidth
  }
  if (current.length > 0 || lines.length === 0 || endedWithNewline) finish()
  return lines
}
