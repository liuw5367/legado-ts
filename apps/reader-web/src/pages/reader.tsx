import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch, type ApiChapter, type ApiContent, type ApiToc } from '../lib/api.ts'

export function ReaderPage() {
  const { bookId = '', chapterId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const editionKey = searchParams.get('editionKey') ?? ''
  const [content, setContent] = useState<ApiContent | null>(null)
  const [toc, setToc] = useState<ApiToc | null>(null)
  const [error, setError] = useState('')
  const articleRef = useRef<HTMLElement>(null)
  const [fontSize, setFontSize] = useState(18)
  useEffect(() => { void Promise.all([apiFetch<{ content: { content: ApiContent } }>(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}?editionKey=${encodeURIComponent(editionKey)}`), apiFetch<{ toc: ApiToc }>(`/api/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`)]).then(([contentResult, tocResult]) => { setContent(contentResult.content.content); setToc(tocResult.toc); window.scrollTo({ top: 0, behavior: 'auto' }) }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '正文加载失败')) }, [bookId, chapterId, editionKey])
  useEffect(() => { if (content === null) return; const chapter = content.chapter; const timer = window.setTimeout(() => { void apiFetch(`/api/books/${encodeURIComponent(bookId)}/position`, { method: 'POST', body: JSON.stringify({ editionKey, chapterId, chapterUrl: chapter.chapterUrl, chapterIndex: chapter.index, title: chapter.title ?? `第 ${chapter.index + 1} 章`, paragraphIndex: 0, offset: 0, version: 0 }) }).catch(() => undefined) }, 600); return () => window.clearTimeout(timer) }, [bookId, chapterId, editionKey, content])
  const paragraphs = useMemo(() => content?.cleaned.split(/\n+/u).map((text) => text.trim()).filter(Boolean) ?? [], [content])
  const siblings = toc?.chapters.filter((chapter) => chapter.isVolume !== true) ?? []
  const currentIndex = siblings.findIndex((chapter) => chapter.chapterId === chapterId)
  const previous = currentIndex > 0 ? siblings[currentIndex - 1] : undefined
  const next = currentIndex >= 0 ? siblings[currentIndex + 1] : undefined
  if (error.length > 0) return <section className="card"><p className="error">{error}</p><Link className="link" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`}>返回目录</Link></section>
  if (content === null) return <section className="card"><p className="muted">正在读取正文…</p></section>
  return <section className="reader-page"><header className="reader-toolbar"><Link className="button secondary" to={`/books/${encodeURIComponent(bookId)}/toc?editionKey=${encodeURIComponent(editionKey)}`}>目录</Link><div className="reader-title"><span className="muted">{content.chapter.index + 1}</span><strong>{content.chapter.title ?? `第 ${content.chapter.index + 1} 章`}</strong></div><div className="reader-controls"><label>字号 <input type="range" min="15" max="26" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} /></label></div></header><article className="reader-content" ref={articleRef} style={{ fontSize: `${fontSize}px` }}>{paragraphs.length === 0 ? <p className="muted">本章暂无正文。</p> : paragraphs.map((paragraph, index) => <p data-paragraph={index} key={`${index}:${paragraph.slice(0, 12)}`}>{paragraph}</p>)}</article><nav className="reader-pagination" aria-label="章节导航">{previous === undefined ? <span /> : <Link className="button secondary" to={chapterLink(bookId, previous, editionKey)}>上一章</Link>}<span className="muted">{currentIndex < 0 ? '' : `${currentIndex + 1} / ${siblings.length}`}</span>{next === undefined ? <span /> : <Link className="button" to={chapterLink(bookId, next, editionKey)}>下一章</Link>}</nav></section>
}

function chapterLink(bookId: string, chapter: ApiChapter, editionKey: string): string { return `/books/${encodeURIComponent(bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(editionKey)}` }
