import type { ChapterContent } from '../workflows/types.ts'

export type ReadingTextFormat = 'bold' | 'italic' | 'underline' | 'code'
export interface ReadingTextRun {
  text: string
  formats: readonly ReadingTextFormat[]
}
export type ReadingBlock =
  | { kind: 'paragraph'; runs: ReadingTextRun[] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'pageBreak' }
export interface ReadingDocument { blocks: ReadingBlock[] }

/** 宿主仅解析节点，过滤、断段和资源策略统一由 core 决定。children 必须包含顺序完整的文本节点。 */
export type ReadingHtmlNode =
  | { kind: 'text'; text: string }
  | { kind: 'element'; tag: string; attributes: Readonly<Record<string, string>>; children: readonly ReadingHtmlNode[] }
export type ReadingHtmlParser = (html: string) => readonly ReadingHtmlNode[]
export type ReadingContentInput = Pick<ChapterContent, 'contentType' | 'cleaned' | 'resources'> & { baseUrl?: string | undefined }

const removedTags = new Set(['script', 'style', 'iframe', 'form', 'object', 'embed', 'svg', 'audio', 'video', 'head', 'title', 'template', 'noscript'])
const blockTags = new Set(['p', 'div', 'blockquote', 'pre', 'li', 'ul', 'ol', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'table', 'tr', 'td', 'th', 'hr'])
const formats: readonly ReadingTextFormat[] = ['bold', 'italic', 'underline', 'code']
const formatBits: Record<string, number> = { b: 1, strong: 1, i: 2, em: 2, u: 4, code: 8 }

/** 正文图片只允许网络图片及明确的位图 data URL，拒绝 SVG 和其他可执行资源。 */
export function readingImageUrl(value: string, baseUrl?: string): string | undefined {
  const source = value.trim()
  if (!source) return undefined
  // data URL 限定常见位图 MIME 和 base64；不能放宽为任意 data:image。
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/iu.test(source)) return source
  try {
    const url = baseUrl === undefined ? new URL(source) : new URL(source, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch { return undefined }
}

/** 将已提取的正文转换为阅读块；不再次执行书源替换或 formatChapterBody。 */
export function normalizeReadingContent(input: ReadingContentInput, parseHtml?: ReadingHtmlParser): ReadingDocument {
  const blocks: ReadingBlock[] = []
  let runs: { text: string; mask: number; pre: boolean }[] = []
  const inlineImages = new Set<string>()
  function append(text: string, mask: number, pre = false) {
    if (!text) return
    const last = runs.at(-1)
    if (last?.mask === mask && last.pre === pre) last.text += text
    else runs.push({ text, mask, pre })
  }
  function flush() {
    // 去掉来源缩进和段尾空白，正文缩进由阅读器样式控制；段内空格原样保留。
    while (runs.length && !runs[0]!.pre && !(runs[0]!.text = runs[0]!.text.trimStart())) runs.shift()
    while (runs.length && !runs.at(-1)!.pre && !(runs.at(-1)!.text = runs.at(-1)!.text.trimEnd())) runs.pop()
    const text = runs.map((run) => run.text).join('')
    if (text.trim() === '[newpage]' && runs.every((run) => run.mask === 0)) {
      if (blocks.length && blocks.at(-1)?.kind !== 'pageBreak') blocks.push({ kind: 'pageBreak' })
    } else if (text.trim()) blocks.push({ kind: 'paragraph', runs: runs.map(({ text, mask }) => ({ text, formats: formats.filter((_, index) => Boolean(mask & (1 << index))) })) })
    runs = []
  }
  function pageBreak() {
    flush()
    if (blocks.length && blocks.at(-1)?.kind !== 'pageBreak') blocks.push({ kind: 'pageBreak' })
  }
  function image(value: string, alt: string) {
    const src = readingImageUrl(value, input.baseUrl)
    if (!src) return
    flush(); blocks.push({ kind: 'image', src, alt }); inlineImages.add(src)
  }
  function html(value: string) {
    if (!parseHtml) throw new Error('capability-missing: 正文 HTML 解析器未提供')
    const stack: { node: ReadingHtmlNode; mask: number; pre: boolean; root?: boolean; exit?: boolean }[] = []
    const push = (nodes: readonly ReadingHtmlNode[], mask: number, pre: boolean, root = false) => {
      for (let index = nodes.length - 1; index >= 0; index--) stack.push({ node: nodes[index]!, mask, pre, root })
    }
    push(parseHtml(value), 0, false, true)
    while (stack.length) {
      const { node, mask, pre, root, exit } = stack.pop()!
      if (node.kind === 'text') {
        if (pre || root && node.text.trim().length > 0) {
          // pre 中的换行有排版语义；普通 HTML 的源码换行仅参与空白折叠。
          const lines = node.text.replace(/\r\n?/gu, '\n').split('\n')
          lines.forEach((line, index) => { if (index) flush(); append(line, mask, pre) })
        } else {
          // HTML 空白跨行内节点也只保留一个空格。
          let text = node.text.replace(/[\t\n\f\r ]+/gu, ' ')
          if (runs.at(-1)?.text.endsWith(' ') && text.startsWith(' ')) text = text.slice(1)
          append(text, mask)
        }
        continue
      }
      const tag = node.tag.toLowerCase()
      if (removedTags.has(tag)) continue
      const block = blockTags.has(tag) || tag === 'usehtml'
      if (exit) { if (block) flush(); continue }
      if (tag === 'br') { flush(); continue }
      if (tag === 'img') { image(node.attributes.src ?? '', node.attributes.alt ?? '正文插图'); continue }
      if (block) flush()
      stack.push({ node, mask, pre, exit: true })
      push(node.children, mask | (formatBits[tag] ?? 0), pre || tag === 'pre')
    }
  }
  // cleaned 已由抓取流程解码；不含标签的 HTML 类型结果也按普通文本保留换行和实体字面量。
  if (input.contentType === 'html' && input.cleaned.includes('<')) html(input.cleaned)
  else {
    // text 也可能保留 Android 特殊格式与图片；其他标签和实体仍作为普通文字。
    // 这里只识别保留标记的范围；属性引号中的 > 不是 img 结束，标签解释仍交给宿主解析器。
    const special = /<usehtml>[\s\S]*?<\/usehtml>|<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu
    let from = 0
    const text = (value: string) => {
      value.replace(/\r\n?/gu, '\n').split('\n').forEach((line, index) => {
        if (index) flush()
        if (line.trim() === '[newpage]') pageBreak()
        else append(line, 0)
      })
    }
    for (const match of input.cleaned.matchAll(special)) {
      text(input.cleaned.slice(from, match.index))
      flush(); html(match[0]); flush()
      from = match.index + match[0].length
    }
    text(input.cleaned.slice(from))
  }
  flush()
  while (blocks.at(-1)?.kind === 'pageBreak') blocks.pop()
  const knownImages = new Set(inlineImages)
  for (const resource of input.resources) {
    if (resource.kind !== 'image') continue
    const src = readingImageUrl(resource.url, input.baseUrl)
    if (src && !knownImages.has(src)) { blocks.push({ kind: 'image', src, alt: '正文插图' }); knownImages.add(src) }
  }
  return { blocks }
}

/** 数组索引与正文块索引一致，图片及分页标记占空文本；偏移采用 UTF-16。 */
export function readingParagraphTexts(document: ReadingDocument): string[] {
  return document.blocks.map((block) => block.kind === 'paragraph' ? block.runs.map((run) => run.text).join('') : '')
}
