import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { comparePoints, readerMark, markSaveInput, type MarkAnchor, type ReadingMark, type ReaderMark, type MarkInput } from '../../shared/reading-annotations.ts'
import { apiFetch, type ApiContent, type ApiToc } from './api.ts'
import { usePageActivity, usePageLoadEffect, usePageNavigation } from './use-page-resource.ts'
import { pageIndexForAnchor, type PageLayout } from './reader-pagination.ts'
import { createAnchor, rangeForAnchor, resolveAnchor, selectedAnchor, textFingerprint, visibleTextPoint } from './reader-annotations.ts'

export function useReaderMarks({ texts, articleRef, bookId, editionKey, chapterId, content, toc, blocked, paged, layout, pageIndex, positionReady, onRestore, onPage, onInteract }: { texts: string[]; articleRef: RefObject<HTMLElement | null>; bookId: string; editionKey: string; chapterId: string; content: ApiContent | null; toc: ApiToc | null; blocked: boolean; paged: boolean; layout: PageLayout; pageIndex: number; positionReady: boolean; onRestore: (point: MarkAnchor['start']) => void; onPage: (page: number) => void; onInteract: () => void }) {
  const page = usePageActivity(); const navigation = usePageNavigation(); const userId = navigation?.userId; const [params] = useSearchParams(); const [annotations, setAnnotations] = useState<ReaderMark[]>([]); const [bookmarks, setBookmarks] = useState<ReaderMark[]>([]); const [selection, setSelection] = useState<{ anchor: MarkAnchor; rect: DOMRect; mark: ReaderMark | null } | null>(null); const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0); const [viewportVersion, setViewportVersion] = useState(0)
  const identity = JSON.stringify([bookId, editionKey, chapterId, toc?.sourceFingerprint]); const identityRef = useRef(identity); identityRef.current = identity
  const restoreIdentity = JSON.stringify([identity, page?.location.key ?? '']);
  const preservedSelection = useRef<{ anchor: MarkAnchor; rect: DOMRect } | null>(null)
  const resetIdentity = useRef(identity)
  const restoredMark = useRef(''); const selectionId = useRef<string | null>(null)
  const hash = content ? textFingerprint(content.cleaned) : ''
  const resolved = useMemo(() => annotations.filter((r) => r.editionKey === editionKey && r.chapterUrl === content?.chapter.chapterUrl && r.sourceFingerprint === toc?.sourceFingerprint).flatMap((r) => { const anchor = resolveAnchor(texts, r.anchor, hash); return anchor ? [{ ...r, anchor }] : [] }), [annotations, texts, hash, editionKey, content?.chapter.chapterUrl, toc?.sourceFingerprint])
  useEffect(() => {
    if (resetIdentity.current === identity) return
    resetIdentity.current = identity; setBusy(false); setSelection(null); setEditing(false); setError(''); setAnnotations([]); setBookmarks([]); restoredMark.current = ''; selectionId.current = null
  }, [identity])
  useEffect(() => () => { setSelection(null); setEditing(false) }, [page?.id])
  usePageLoadEffect((settle) => {
    if (!content) { settle(); return }
    const controller = new AbortController(); const query = '?view=reader&editionKey=' + encodeURIComponent(editionKey) + '&chapterUrl=' + encodeURIComponent(content.chapter.chapterUrl)
    void Promise.all(['annotations', 'bookmarks'].map((kind) => apiFetch<{ items: ReaderMark[] }>('/api/books/' + encodeURIComponent(bookId) + '/' + kind + query, { signal: controller.signal }))).then(([a, b]) => { if (controller.signal.aborted) return; if (articleRef.current && !editing) preservedSelection.current = selectedAnchor(articleRef.current, hash); setAnnotations(a!.items); setBookmarks(b!.items); setError('') }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取标记失败') }).finally(() => { if (!controller.signal.aborted) settle() })
    return () => controller.abort()
  }, [identity, content?.chapter.chapterUrl, hash, toc?.revision, retry], ['notes'])
  useLayoutEffect(() => {
    const previous = preservedSelection.current; preservedSelection.current = null
    const root = articleRef.current
    if (!previous || !root || editing || page?.active === false) return
    const range = rangeForAnchor(root, previous.anchor); const native = window.getSelection()
    if (range && native) { native.removeAllRanges(); native.addRange(range); setSelection({ anchor: previous.anchor, rect: range.getBoundingClientRect(), mark: null }) }
  }, [annotations])
  useEffect(() => {
    if (page?.active === false) return
    let timer: number | undefined
    const changed = () => { if (editing || blocked || busy) return; if (timer) window.clearTimeout(timer); timer = window.setTimeout(() => {
      const root = articleRef.current; const candidate = root ? selectedAnchor(root, hash) : null
      if (candidate) { onInteract(); selectionId.current = null; const exact = resolved.find((r) => comparePoints(r.anchor.start, candidate.anchor.start) === 0 && comparePoints(r.anchor.end, candidate.anchor.end) === 0); setSelection({ ...candidate, mark: exact ? annotations.find((r) => r.id === exact.id) ?? null : null }) }
      else setSelection((current) => current?.mark ? current : null)
    }, 120) }
    const scrolled = () => {
      setViewportVersion((n) => n + 1)
      if (editing) return
      const root = articleRef.current; const candidate = root ? selectedAnchor(root, hash) : null
      if (candidate) {
        const matched = resolved.find((row) => comparePoints(row.anchor.start, candidate.anchor.start) === 0 && comparePoints(row.anchor.end, candidate.anchor.end) === 0)
        setSelection({ ...candidate, mark: matched ? annotations.find((row) => row.id === matched.id) ?? null : null })
      }
      else setSelection(null)
    }
    const outside = (event: PointerEvent) => {
      if (editing) return
      if (event.target instanceof Element && event.target.closest('.reader-selection-popover,.reader-mark')) return
      const rect = selection?.rect
      if (rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return
      if (event.pointerType === 'touch' && rect && event.clientY >= rect.top - 36 && event.clientY <= rect.bottom + 36 && Math.min(Math.abs(event.clientX - rect.left), Math.abs(event.clientX - rect.right)) <= 36) return
      setSelection(null)
    }
    document.addEventListener('selectionchange', changed); window.addEventListener('scroll', scrolled, { passive: true }); document.addEventListener('pointerdown', outside)
    return () => { if (timer) window.clearTimeout(timer); document.removeEventListener('selectionchange', changed); window.removeEventListener('scroll', scrolled); document.removeEventListener('pointerdown', outside) }
  }, [page?.active, hash, editing, blocked, busy, annotations, resolved, selection?.rect])
  useEffect(() => { if (blocked || page?.active === false) { setSelection(null); if (page?.active === false) setEditing(false) } }, [blocked, page?.active])
  useEffect(() => { setSelection(null) }, [paged, layout.pageWidth, layout.pageCount, content])
  const currentBookmark = useMemo(() => {
    const root = articleRef.current; if (!root) return null
    const viewport = root.getBoundingClientRect()
    return bookmarks.find((mark) => { if (mark.sourceFingerprint !== toc?.sourceFingerprint) return false; const anchor = resolveAnchor(texts, mark.anchor, hash); const range = anchor ? rangeForAnchor(root, anchor) : null; const rect = range?.getClientRects()[0]; return rect && rect.top < (paged ? viewport.bottom : window.innerHeight) && rect.bottom > (paged ? viewport.top : 0) && (!paged || rect.right > viewport.left && rect.left < viewport.right) }) ?? null
  }, [bookmarks, texts, hash, viewportVersion, paged, layout, pageIndex, articleRef, toc?.sourceFingerprint])
  useLayoutEffect(() => {
    const id = params.get('mark'); if (page?.active === false || !positionReady || !id || restoredMark.current === restoreIdentity + id || !content || !toc || paged && layout.pageCount === 0) return
    const mark = (params.get('markKind') === 'bookmarks' ? bookmarks : annotations).find((r) => r.id === id); const root = articleRef.current
    if (!mark || !root) return
    const anchor = mark.sourceFingerprint === toc.sourceFingerprint ? resolveAnchor(texts, mark.anchor, hash) : null
    if (!anchor) { setError('原文已变化，无法定位。摘录和想法仍然保留。'); return }
    onRestore(anchor.start)
    const frame = window.requestAnimationFrame(() => {
      restoredMark.current = restoreIdentity + id
      if (paged) { const index = pageIndexForAnchor(root, anchor.start, layout); onPage(index) }
      else { const range = rangeForAnchor(root, anchor); const rect = range?.getBoundingClientRect(); if (rect) window.scrollTo({ top: window.scrollY + rect.top - 80, behavior: 'auto' }) }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [params, bookmarks, annotations, identity, content, toc, texts, hash, paged, layout, positionReady, restoreIdentity, page?.active])
  function inputFor(anchor: MarkAnchor, color: ReadingMark['color'], note: string | null): MarkInput {
    if (!content || !toc) throw new Error('正文尚未就绪')
    return { editionKey, sourceFingerprint: toc.sourceFingerprint, chapterId, chapterUrl: content.chapter.chapterUrl, chapterIndex: content.chapter.index, chapterTitle: content.chapter.title ?? '', tocRevision: toc.revision, anchor, color, note }
  }

  async function save(color: ReadingMark['color'], note: string | null, throwError = false) {
    if (!selection || busy) return
    setBusy(true); setError(''); const ownIdentity = identity
    try {
      const existing = selection.mark; const id = existing?.id ?? selectionId.current ?? crypto.randomUUID(); selectionId.current = id
      const input = existing ? { ...markSaveInput(existing), color, note } : inputFor(selection.anchor, color, note)
      const result = await apiFetch<{ item: ReaderMark }>('/api/books/' + encodeURIComponent(bookId) + '/annotations/' + id + '?view=reader', { method: 'PUT', body: JSON.stringify(input) }, userId)
      if (identityRef.current === ownIdentity) { setAnnotations((rows) => [...rows.filter((r) => r.id !== result.item.id), readerMark(result.item)]); setSelection(null); window.getSelection()?.removeAllRanges() }
    } catch (reason) { if (identityRef.current === ownIdentity) setError(reason instanceof Error ? reason.message : '保存失败'); if (throwError) throw reason } finally { if (identityRef.current === ownIdentity) setBusy(false) }
  }
  async function remove() {
    if (!selection?.mark || busy) return
    const mark = selection.mark; const ownIdentity = identity; setBusy(true); setError('')
    try { await apiFetch('/api/books/' + encodeURIComponent(bookId) + '/annotations/' + mark.id + '?view=reader', { method: 'DELETE', body: JSON.stringify({ expectedVersion: mark.version }) }, userId); if (identityRef.current !== ownIdentity) return; setAnnotations((rows) => rows.filter((r) => r.id !== mark.id)); setSelection(null); window.getSelection()?.removeAllRanges() } catch (reason) { if (identityRef.current === ownIdentity) setError(reason instanceof Error ? reason.message : '删除失败') } finally { if (identityRef.current === ownIdentity) setBusy(false) }
  }
  async function toggleBookmark() {
    const root = articleRef.current; if (!root || busy) return
    setBusy(true); setError(''); const ownIdentity = identity
    try {
      if (currentBookmark) { await apiFetch('/api/books/' + encodeURIComponent(bookId) + '/bookmarks/' + currentBookmark.id + '?view=reader', { method: 'DELETE', body: JSON.stringify({ expectedVersion: currentBookmark.version }) }, userId); if (identityRef.current !== ownIdentity) return; setBookmarks((rows) => rows.filter((r) => r.id !== currentBookmark.id)); return }
      const point = visibleTextPoint(root, paged) ?? { paragraphIndex: 0, offset: 0 }; const text = texts[point.paragraphIndex] ?? ''; if (!text.length) throw new Error('当前位置没有可添加书签的文字')
      const start = { ...point, offset: Math.min(point.offset, text.length - 1) }; const end = { ...start, offset: Math.min(start.offset + 80, text.length) }; const anchor = createAnchor(texts, start, end, hash)
      const result = await apiFetch<{ item: ReaderMark }>('/api/books/' + encodeURIComponent(bookId) + '/bookmarks/' + crypto.randomUUID() + '?view=reader', { method: 'PUT', body: JSON.stringify(inputFor(anchor, 'orange', null)) }, userId); if (identityRef.current !== ownIdentity) return; setBookmarks((rows) => [...rows, readerMark(result.item)])
    } catch (reason) { if (identityRef.current === ownIdentity) setError(reason instanceof Error ? reason.message : '保存书签失败') } finally { if (identityRef.current === ownIdentity) setBusy(false) }
  }
  function openMark(target: Element) {
    if (window.getSelection()?.toString()) return false
    const markElement = target.closest<HTMLElement>('[data-mark-id]'); if (!markElement || blocked) return false
    const stored = annotations.find((r) => r.id === markElement.dataset.markId); if (!stored) return false
    onInteract(); window.getSelection()?.removeAllRanges(); setSelection({ anchor: stored.anchor, rect: markElement.getBoundingClientRect(), mark: stored }); return true
  }
  return { resolved, selection, editing, busy, error, setError, retry: () => setRetry((n) => n + 1), close: () => setSelection(null), openMark, currentBookmark, toggleBookmark, remove, save, startThought: () => setEditing(true), stopThought: () => { setEditing(false); setSelection(null) } }
}
