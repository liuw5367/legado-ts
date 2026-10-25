import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { comparePoints, type MarkAnchor, type ReadingMark, type MarkInput } from '../../shared/reading-annotations.ts'
import { apiFetch, type ApiContent, type ApiToc } from './api.ts'
import { usePageActivity, usePageLoadEffect } from './use-page-resource.ts'
import { pageIndexForAnchor, type PageLayout } from './reader-pagination.ts'
import { createAnchor, rangeForAnchor, resolveAnchor, selectedAnchor, textFingerprint, visibleTextPoint } from './reader-annotations.ts'
import { sanitizeChapterHtml } from './html-content.ts'

export function useReaderMarks({ articleRef, bookId, editionKey, chapterId, content, toc, blocked, paged, layout, pageIndex, positionReady, onRestore, onPage, onInteract }: { articleRef: RefObject<HTMLElement | null>; bookId: string; editionKey: string; chapterId: string; content: ApiContent | null; toc: ApiToc | null; blocked: boolean; paged: boolean; layout: PageLayout; pageIndex: number; positionReady: boolean; onRestore: () => void; onPage: (page: number) => void; onInteract: () => void }) {
  const page = usePageActivity(); const [params] = useSearchParams(); const [annotations, setAnnotations] = useState<ReadingMark[]>([]); const [bookmarks, setBookmarks] = useState<ReadingMark[]>([]); const [selection, setSelection] = useState<{ anchor: MarkAnchor; rect: DOMRect; mark: ReadingMark | null } | null>(null); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0); const [viewportVersion, setViewportVersion] = useState(0)
  const identity = JSON.stringify([bookId, editionKey, chapterId]); const identityRef = useRef(identity); identityRef.current = identity
  const restoredMark = useRef(''); const selectionId = useRef<string | null>(null)
  const hash = content ? textFingerprint(content.cleaned) : ''
  const texts = useMemo(() => { if (!content) return []; if (content.contentType === 'text') return content.cleaned.split(/\n+/u).map((p) => p.trim()).filter(Boolean); const doc = new DOMParser().parseFromString(sanitizeChapterHtml(content.cleaned), 'text/html'); return [doc.body.textContent ?? ''] }, [content])
  const resolved = useMemo(() => annotations.filter((r) => r.editionKey === editionKey && r.chapterUrl === content?.chapter.chapterUrl && r.sourceFingerprint === toc?.sourceFingerprint).flatMap((r) => { const anchor = resolveAnchor(texts, r.anchor, hash); return anchor ? [{ ...r, anchor }] : [] }), [annotations, texts, hash, editionKey, content?.chapter.chapterUrl, toc?.sourceFingerprint])
  useEffect(() => { setSelection(null); setEditing(false); setError(''); setAnnotations([]); setBookmarks([]); restoredMark.current = ''; selectionId.current = null }, [identity])
  usePageLoadEffect((settle) => {
    if (!content) { settle(); return }
    const controller = new AbortController(); const query = '?editionKey=' + encodeURIComponent(editionKey) + '&chapterUrl=' + encodeURIComponent(content.chapter.chapterUrl)
    void Promise.all(['annotations', 'bookmarks'].map((kind) => apiFetch<{ items: ReadingMark[] }>('/api/books/' + encodeURIComponent(bookId) + '/' + kind + query, { signal: controller.signal }))).then(([a, b]) => { setAnnotations(a!.items); setBookmarks(b!.items); setError('') }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取标记失败') }).finally(() => { if (!controller.signal.aborted) settle() })
    return () => controller.abort()
  }, [identity, content?.chapter.chapterUrl, hash, retry], ['notes'])
  useEffect(() => {
    if (page?.active === false) return
    let timer: number | undefined
    const changed = () => { if (editing || blocked || busy) return; if (timer) window.clearTimeout(timer); timer = window.setTimeout(() => {
      const root = articleRef.current; const candidate = root ? selectedAnchor(root, hash) : null
      if (candidate) { onInteract(); selectionId.current = null; const exact = annotations.find((r) => comparePoints(r.anchor.start, candidate.anchor.start) === 0 && comparePoints(r.anchor.end, candidate.anchor.end) === 0); setSelection({ ...candidate, mark: exact ?? null }) }
    }, 120) }
    const scrolled = () => { setViewportVersion((n) => n + 1); if (!editing) setSelection(null) }
    const outside = (event: PointerEvent) => { if (editing) return; if (event.target instanceof Element && event.target.closest('.reader-selection-popover,.reader-mark')) return; if (!window.getSelection()?.toString()) setSelection(null) }
    document.addEventListener('selectionchange', changed); window.addEventListener('scroll', scrolled, { passive: true }); document.addEventListener('pointerdown', outside)
    return () => { if (timer) window.clearTimeout(timer); document.removeEventListener('selectionchange', changed); window.removeEventListener('scroll', scrolled); document.removeEventListener('pointerdown', outside) }
  }, [page?.active, hash, editing, blocked, busy, annotations])
  useEffect(() => { if (blocked) setSelection(null) }, [blocked])
  useEffect(() => { setSelection(null) }, [paged, layout.pageWidth, layout.pageCount, content])
  const currentBookmark = useMemo(() => {
    const root = articleRef.current; if (!root) return null
    const viewport = root.getBoundingClientRect()
    return bookmarks.find((mark) => { const anchor = resolveAnchor(texts, mark.anchor, hash); const range = anchor ? rangeForAnchor(root, anchor) : null; const rect = range?.getClientRects()[0]; return rect && rect.top < (paged ? viewport.bottom : window.innerHeight) && rect.bottom > (paged ? viewport.top : 0) && (!paged || rect.right > viewport.left && rect.left < viewport.right) }) ?? null
  }, [bookmarks, texts, hash, viewportVersion, paged, layout, pageIndex, articleRef])
  useLayoutEffect(() => {
    const id = params.get('mark'); if (!positionReady || !id || restoredMark.current === identity + id || !content || !toc || paged && layout.pageCount === 0) return
    const mark = (params.get('markKind') === 'bookmarks' ? bookmarks : annotations).find((r) => r.id === id); const root = articleRef.current
    if (!mark || !root) return
    restoredMark.current = identity + id
    onRestore()
    const anchor = resolveAnchor(texts, mark.anchor, hash)
    if (!anchor) { setError('原文已变化，无法定位。摘录和想法仍然保留。'); return }
    if (paged) { const index = pageIndexForAnchor(root, anchor.start, layout); if (index !== undefined) onPage(index) }
    else { const range = rangeForAnchor(root, anchor); const rect = range?.getBoundingClientRect(); if (rect) window.scrollTo({ top: window.scrollY + rect.top - 80, behavior: 'auto' }) }
  }, [params, bookmarks, annotations, identity, content, toc, texts, hash, paged, layout, positionReady])
  function inputFor(anchor: MarkAnchor, color: ReadingMark['color'], note: string | null): MarkInput {
    if (!content || !toc) throw new Error('正文尚未就绪')
    return { editionKey, sourceFingerprint: toc.sourceFingerprint, chapterId, chapterUrl: content.chapter.chapterUrl, chapterIndex: content.chapter.index, chapterTitle: content.chapter.title, tocRevision: toc.revision, anchor, color, note }
  }
  function markInput(mark: ReadingMark): MarkInput { const { id: _id, userId: _user, bookId: _book, bookName: _name, author: _author, createdAt: _created, updatedAt: _updated, deletedAt: _deleted, version, ...input } = mark; return { ...input, expectedVersion: version } }
  async function save(color: ReadingMark['color'], note: string | null, throwError = false) {
    if (!selection || busy) return
    setBusy(true); setError(''); const ownIdentity = identity
    try {
      const existing = selection.mark; const id = existing?.id ?? selectionId.current ?? crypto.randomUUID(); selectionId.current = id
      const input = existing ? { ...markInput(existing), color, note } : inputFor(selection.anchor, color, note)
      const result = await apiFetch<{ item: ReadingMark }>('/api/books/' + encodeURIComponent(bookId) + '/annotations/' + id, { method: 'PUT', body: JSON.stringify(input) })
      if (identityRef.current === ownIdentity) { setAnnotations((rows) => [...rows.filter((r) => r.id !== result.item.id), result.item]); setSelection(null); window.getSelection()?.removeAllRanges() }
    } catch (reason) { if (identityRef.current === ownIdentity) setError(reason instanceof Error ? reason.message : '保存失败'); if (throwError) throw reason } finally { setBusy(false) }
  }
  async function remove() {
    if (!selection?.mark || busy) return
    const mark = selection.mark; setBusy(true); setError('')
    try { await apiFetch('/api/books/' + encodeURIComponent(bookId) + '/annotations/' + mark.id, { method: 'DELETE', body: JSON.stringify({ expectedVersion: mark.version }) }); setAnnotations((rows) => rows.filter((r) => r.id !== mark.id)); setSelection(null); window.getSelection()?.removeAllRanges() } catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败') } finally { setBusy(false) }
  }
  async function toggleBookmark() {
    const root = articleRef.current; if (!root || busy) return
    setBusy(true); setError('')
    try {
      if (currentBookmark) { await apiFetch('/api/books/' + encodeURIComponent(bookId) + '/bookmarks/' + currentBookmark.id, { method: 'DELETE', body: JSON.stringify({ expectedVersion: currentBookmark.version }) }); setBookmarks((rows) => rows.filter((r) => r.id !== currentBookmark.id)); return }
      const point = visibleTextPoint(root, paged) ?? { paragraphIndex: 0, offset: 0 }; const text = texts[point.paragraphIndex] ?? ''; if (!text.length) throw new Error('当前位置没有可添加书签的文字')
      const start = { ...point, offset: Math.min(point.offset, text.length - 1) }; const end = { ...start, offset: Math.min(start.offset + 80, text.length) }; const anchor = createAnchor(texts, start, end, hash)
      const result = await apiFetch<{ item: ReadingMark }>('/api/books/' + encodeURIComponent(bookId) + '/bookmarks/' + crypto.randomUUID(), { method: 'PUT', body: JSON.stringify(inputFor(anchor, 'orange', null)) }); setBookmarks((rows) => [...rows, result.item])
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存书签失败') } finally { setBusy(false) }
  }
  function openMark(target: Element) {
    const markElement = target.closest<HTMLElement>('[data-mark-id]'); if (!markElement || blocked) return false
    const stored = annotations.find((r) => r.id === markElement.dataset.markId); if (!stored) return false
    onInteract(); window.getSelection()?.removeAllRanges(); setSelection({ anchor: stored.anchor, rect: markElement.getBoundingClientRect(), mark: stored }); return true
  }
  return { resolved, selection, editing, busy, error, setError, retry: () => setRetry((n) => n + 1), close: () => setSelection(null), openMark, currentBookmark, toggleBookmark, remove, save, startThought: () => setEditing(true), stopThought: () => { setEditing(false); setSelection(null) } }
}
