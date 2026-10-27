import { memo, type ReactNode } from 'react'
import type { ReadingDocument, ReadingTextRun } from '@legado/source-core'
import type { ReadingMark } from '../../shared/reading-annotations.ts'
import { markedFragments } from '../lib/reader-annotations.ts'

/** 独立记忆正文，工具栏和原生选区状态更新不替换正文节点。 */
export const ReaderBody = memo(function ReaderBody({ document, marks }: { document: ReadingDocument; marks: ReadingMark[] }) {
  if (!document.blocks.length) return <p className="muted">本章暂无正文。</p>
  return document.blocks.map((block, index) => {
    const breakBefore = document.blocks[index - 1]?.kind === 'pageBreak' ? ' reader-page-break-before' : ''
    if (block.kind === 'pageBreak') return <span hidden data-paragraph={index} key={index} />
    if (block.kind === 'image') return <p className={`reader-resource${breakBefore}`} data-paragraph={index} key={index}><img src={block.src} alt={block.alt} loading="lazy" decoding="async" /></p>
    let offset = 0
    return <p className={`reader-paragraph${breakBefore}`} data-paragraph={index} key={index}>{block.runs.map((run, runIndex) => {
      const from = offset; offset += run.text.length
      const local = marks.flatMap((mark) => {
        const start = mark.anchor.start; const end = mark.anchor.end
        if (index < start.paragraphIndex || index > end.paragraphIndex) return []
        const a = Math.max(0, (index === start.paragraphIndex ? start.offset : 0) - from)
        const b = Math.min(run.text.length, (index === end.paragraphIndex ? end.offset : offset) - from)
        return b > a ? [{ ...mark, anchor: { ...mark.anchor, start: { paragraphIndex: 0, offset: a }, end: { paragraphIndex: 0, offset: b } } }] : []
      })
      return <FormattedRun run={run} key={runIndex}>{markedFragments(run.text, 0, local).map((part, i) => part.mark ? <span className="reader-mark" data-mark-id={part.mark.id} data-color={part.mark.color} role="button" tabIndex={0} aria-label={part.mark.note ? '编辑想法' : '编辑标记'} key={i}>{part.text}</span> : part.text)}</FormattedRun>
    })}</p>
  })
})

function FormattedRun({ run, children }: { run: ReadingTextRun; children: ReactNode }) {
  let content = children
  for (const format of run.formats) {
    if (format === 'bold') content = <strong>{content}</strong>
    else if (format === 'italic') content = <em>{content}</em>
    else if (format === 'underline') content = <u>{content}</u>
    else content = <code>{content}</code>
  }
  return <>{content}</>
}
