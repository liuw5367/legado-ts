import type { ReaderHeaderSeparator, ReaderSettings } from './storage-model.ts'

export interface ReaderHeaderInput {
  bookName: string
  chapterName: string
  chapterIndex: number
  chapterTotal: number
  pageCurrent: number
  pageTotal: number
  chapterCharacters: number
  message: string
  settings: Pick<ReaderSettings, 'showReaderBookTitle' | 'showReaderChapterTitle' | 'showReaderChapterIndex' | 'showReaderPageProgress' | 'showReaderWordCount' | 'showReaderStatus' | 'readerHeaderSeparator'>
}

export interface ReaderHeaderParts {
  left: string
  right: string
  leftParts: readonly string[]
  rightParts: readonly string[]
  separator: string
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function readerHeaderSeparator(separator: ReaderHeaderSeparator): string {
  if (separator === 'hidden') return ' '
  return separator === 'dash' ? ' — ' : ' · '
}

export function joinReaderHeaderParts(parts: readonly string[], separator: ReaderHeaderSeparator): string {
  const visible = parts.map((part) => part.trim()).filter((part) => part.length > 0)
  return visible.join(readerHeaderSeparator(separator))
}

export function compactReaderStatus(value: string): string {
  const message = value.trim()
  if (message.length === 0) return ''
  if (/^正在加载第\s*\d+\s*章/u.test(message)) return '加载中'
  if (/^正在刷新当前章节/u.test(message)) return '刷新中'
  if (/^已刷新/u.test(message)) return '已刷新'
  if (/^已加载/u.test(message)) return '已加载'
  if (/书籍信息待同步/u.test(message)) return '待同步'
  if (/章节内容为空/u.test(message)) return '内容为空'
  if (/(失败|错误|异常|不可用|无法)/u.test(message)) return '失败'
  return Array.from(graphemeSegmenter.segment(message), (item) => item.segment).slice(0, 6).join('')
}

export function formatReaderHeader(input: ReaderHeaderInput): ReaderHeaderParts {
  const { settings } = input
  const leftParts = [
    settings.showReaderBookTitle ? input.bookName.trim() : '',
    settings.showReaderChapterTitle ? input.chapterName.trim() : '',
    settings.showReaderChapterIndex ? formatChapterIndex(input.chapterIndex, input.chapterTotal) : '',
  ].filter((part) => part.length > 0)
  const rightParts = [
    settings.showReaderPageProgress ? `${input.pageCurrent}/${input.pageTotal}` : '',
    settings.showReaderWordCount ? `${input.chapterCharacters.toLocaleString('zh-CN')}字` : '',
    settings.showReaderStatus ? compactReaderStatus(input.message) : '',
  ].filter((part) => part.length > 0)
  const separator = readerHeaderSeparator(settings.readerHeaderSeparator)
  return {
    left: joinReaderHeaderParts(leftParts, settings.readerHeaderSeparator),
    right: joinReaderHeaderParts(rightParts, settings.readerHeaderSeparator),
    leftParts,
    rightParts,
    separator,
  }
}

function formatChapterIndex(index: number, total: number): string {
  const current = Math.max(1, index + 1)
  return total > 0 ? `${current}/${total}章` : `${current}章`
}
