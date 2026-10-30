import { DialogPresence } from './ui/animated-dialog.tsx'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bookmark, FileText, MessageSquare, Pencil, RotateCcw, Search, Trash2 } from 'lucide-react'
import { apiFetch, type ApiContent } from '../lib/api.ts'
import { usePageActivity, usePageLoadEffect, usePageNavigation, usePageVersion } from '../lib/use-page-resource.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { pageReturnState } from '../lib/page-navigation.ts'
import { resolveAnchor, textFingerprint } from '../../shared/reading-text.ts'
import { markSaveInput, type MarkKind, type MarkSummaryPage, type ReadingMarkListItem, type ReaderMark, type CachedChapter, type TextPoint } from '../../shared/reading-annotations.ts'
import { EmptyState } from './empty-state.tsx'
import { ReadingMarkEditor } from './reading-mark-editor.tsx'
import { DismissibleMessage } from './dismissible-message.tsx'
import { LoadingState } from './loading-state.tsx'
import { Button } from './ui/button.tsx'
import { MoreMenu } from './more-menu.tsx'
import { Sheet } from './ui/sheet.tsx'
import { useReaderSettings } from '../lib/settings-context.tsx'
import { readingDocument } from '../lib/html-content.ts'
import { readingParagraphTexts } from '@legado/source-core'

type MarkDetails = ReadingMarkListItem & ReaderMark & { sourceName: string }
type CachedMarkPage = { items: ReadingMarkListItem[]; cursor: string | null }
const cachedMarkPages = new Map<string, CachedMarkPage>()
export type ReaderMarkDestination = { path: string; editionKey: string; chapterId: string; point: TextPoint }

export function ReadingMarksList({ kind, bookId, q = '', deleted = false, global = false, readerSheet = false, currentProgressTitle, onCurrentProgress, currentEditionKey, activeEditions, onNavigate }: { kind: MarkKind; bookId?: string; q?: string; deleted?: boolean; global?: boolean; readerSheet?: boolean; currentProgressTitle?: string; onCurrentProgress?: () => void; currentEditionKey?: string; activeEditions?: Record<string, string | undefined>; onNavigate?: (destination: ReaderMarkDestination) => void }) {
  const page = usePageActivity(); const navigation = usePageNavigation(); const userId = navigation?.userId; const notesVersion = usePageVersion(['notes']); const active = useRef(true); active.current = page?.active !== false
  const [pendingPurge, setPendingPurge] = useState<ReadingMarkListItem | null>(null)
  const [items, setItems] = useState<ReadingMarkListItem[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [retry, setRetry] = useState(0); const [busy, setBusy] = useState<string | null>(null); const [editing, setEditing] = useState<MarkDetails | null>(null); const [missing, setMissing] = useState<MarkDetails | null>(null); const [retryMark, setRetryMark] = useState<ReadingMarkListItem | null>(null); const [cachePreview, setCachePreview] = useState<MarkDetails | null>(null); const [previewChapter, setPreviewChapter] = useState<CachedChapter | null>(null); const [previewLoading, setPreviewLoading] = useState(false); const [previewError, setPreviewError] = useState(''); const [previewRetry, setPreviewRetry] = useState(0); const [purging, setPurging] = useState<string | null>(null)
  const generation = useRef(0)
  const openGeneration = useRef(0); const openController = useRef<AbortController | null>(null)
  const cache = useBookCache(); const navigate = useNavigate(); const location = useLocation()
  const { settings } = useReaderSettings()
  const params = new URLSearchParams({ q, deleted: String(deleted) }); if (bookId) params.set('bookId', bookId)
  const path = global ? '/api/annotations?' + params : '/api/books/' + encodeURIComponent(bookId ?? '') + '/' + kind + '?' + params
  const cacheKey = `${userId ?? ''}:${notesVersion}:${path}`; const cardLayout = global || readerSheet && kind === 'annotations'
  const empty = !loading && !error && items.length === 0
  const emptyTitle = global && (q.length > 0 || bookId !== undefined) ? '没有符合条件的笔记' : deleted ? '暂无已删除笔记' : kind === 'bookmarks' ? '还没有书签' : '还没有笔记'
  const emptyDescription = global && (q.length > 0 || bookId !== undefined) ? '调整搜索或书籍筛选' : deleted ? '删除的笔记可在此恢复' : kind === 'bookmarks' ? '阅读时点击书签图标添加' : '选中文字即可添加笔记'
  const EmptyIcon = global && (q.length > 0 || bookId !== undefined) ? Search : kind === 'bookmarks' ? Bookmark : MessageSquare
  useEffect(() => () => { openGeneration.current++; openController.current?.abort(); openController.current = null }, [page?.active])
  usePageLoadEffect((settle) => {
    generation.current++; const ownGeneration = generation.current; setBusy(null); setError('')
    const cached = cachedMarkPages.get(cacheKey)
    if (cached) {
      setItems(cached.items); setCursor(cached.cursor); setLoading(false); settle()
      return () => { generation.current++ }
    }
    const controller = new AbortController(); setLoading(true)
    void apiFetch<MarkSummaryPage>(path, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || ownGeneration !== generation.current) return
      const next = { items: result.items, cursor: result.nextCursor }
      cachedMarkPages.set(cacheKey, next); setItems(next.items); setCursor(next.cursor)
    }).catch((reason: unknown) => { if (!controller.signal.aborted && ownGeneration === generation.current) setError(reason instanceof Error ? reason.message : '读取失败') }).finally(() => { if (!controller.signal.aborted && ownGeneration === generation.current) { setLoading(false); settle() } })
    return () => { generation.current++; controller.abort() }
  }, [cacheKey, path, retry], ['notes'])
  const cachedChapters = useRef(new Map<string, CachedChapter | null>())
  useEffect(() => {
    if (!cachePreview || page?.active === false) return
    const key = JSON.stringify([userId, cachePreview.id, cachePreview.version])
    setPreviewError(''); setPreviewChapter(null)
    if (cachedChapters.current.has(key)) { setPreviewChapter(cachedChapters.current.get(key) ?? null); setPreviewLoading(false); return }
    const controller = new AbortController(); setPreviewLoading(true)
    void apiFetch<{ cachedChapter: CachedChapter | null }>(`/api/books/${encodeURIComponent(cachePreview.bookId)}/annotations/${cachePreview.id}/cached-chapter`, { signal: controller.signal }, userId).then((result) => {
      if (controller.signal.aborted) return
      cachedChapters.current.set(key, result.cachedChapter); setPreviewChapter(result.cachedChapter)
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setPreviewError(reason instanceof Error ? reason.message : '原文加载失败') }).finally(() => { if (!controller.signal.aborted) setPreviewLoading(false) })
    return () => controller.abort()
  }, [cachePreview, userId, previewRetry, page?.active])
  useEffect(() => { setCachePreview(null); cachedChapters.current.clear() }, [userId])
  const markContexts = useRef(new Map<string, MarkDetails>())
  useEffect(() => { markContexts.current.clear() }, [userId])
  async function loadMark(item: ReadingMarkListItem, signal?: AbortSignal): Promise<MarkDetails> {
    const key = JSON.stringify([userId, kind, item.id, item.version])
    const cached = markContexts.current.get(key)
    if (cached) return cached
    const result = await apiFetch<{ item: ReaderMark & { sourceName: string } }>(itemPath(item), { signal: signal ?? null }, userId)
    const detail = { ...item, ...result.item }
    if (!signal?.aborted) markContexts.current.set(key, detail)
    return detail
  }
  async function showMarkDetails(item: ReadingMarkListItem, mode: 'edit' | 'preview') {
    const ownGeneration = generation.current
    setBusy(item.id); setError('')
    try {
      const detail = await loadMark(item)
      if (!active.current || ownGeneration !== generation.current) return
      if (mode === 'edit') setEditing(detail)
      else setCachePreview(detail)
    } catch (reason) { if (active.current && ownGeneration === generation.current) setError(reason instanceof Error ? reason.message : '读取笔记失败') }
    finally { if (ownGeneration === generation.current) setBusy(null) }
  }
  function itemPath(mark: ReadingMarkListItem) { return '/api/books/' + encodeURIComponent(mark.bookId) + '/' + kind + '/' + mark.id }
  function reload() { cachedMarkPages.delete(cacheKey); setRetry((value) => value + 1) }
  async function action(mark: ReadingMarkListItem, restore: boolean) {
    const actionPath = cacheKey; const ownGeneration = generation.current; setBusy(mark.id); setError('')
    try {
      const result = await apiFetch<{ item: ReadingMarkListItem }>(itemPath(mark) + (restore ? '/restore' : '') + '?view=list', { method: restore ? 'POST' : 'DELETE', body: JSON.stringify({ expectedVersion: mark.version }) }, userId)
      const cached = cachedMarkPages.get(actionPath); const source = cached?.items ?? items
      const next = readerSheet ? source.map((row) => row.id === result.item.id ? result.item : row) : source.filter((row) => row.id !== mark.id)
      const page = { items: next, cursor: cached?.cursor ?? cursor }
      cachedMarkPages.set(actionPath, page)
      if (readerSheet) cachedMarkPages.set(`${userId ?? ''}:${Number(notesVersion) + 1}:${path}`, page)
      if (ownGeneration === generation.current) setItems(next)
    } catch (reason) { if (ownGeneration === generation.current) setError(reason instanceof Error ? reason.message : '操作失败') } finally { if (ownGeneration === generation.current) setBusy(null) }
  }
  async function purge(mark: ReadingMarkListItem) {
    const actionPath = cacheKey; const ownGeneration = generation.current; setPurging(mark.id); setError('')
    try {
      await apiFetch(itemPath(mark) + '/permanent', { method: 'DELETE', body: JSON.stringify({ expectedVersion: mark.version }) }, userId)
      const cached = cachedMarkPages.get(actionPath); const next = (cached?.items ?? items).filter((row) => row.id !== mark.id)
      cachedMarkPages.set(actionPath, { items: next, cursor: cached?.cursor ?? cursor })
      if (ownGeneration === generation.current) setItems(next)
    } catch (reason) { if (ownGeneration === generation.current) setError(reason instanceof Error ? reason.message : '删除失败') } finally { if (ownGeneration === generation.current) setPurging(null) }
  }
  function showUnmatched(mark: MarkDetails) {
    setMissing(mark)
    setRetryMark(null)
    setError(`当前书源中找不到这条${kind === 'bookmarks' ? '书签对应的章节' : '笔记对应的章节和内容'}。它来自「${mark.sourceName}」，请手动切换书源后重试。`)
  }
  async function open(item: ReadingMarkListItem) {
    const targetEditionKey = currentEditionKey ?? activeEditions?.[item.bookId]
    openController.current?.abort()
    const controller = new AbortController(); const ownGeneration = ++openGeneration.current
    openController.current = controller
    const isCurrent = () => active.current && !controller.signal.aborted && openGeneration.current === ownGeneration
    setBusy(item.id); setError(''); setMissing(null); setRetryMark(null)
    try {
      const mark = await loadMark(item, controller.signal)
      if (!isCurrent()) return
      if (!targetEditionKey) { showUnmatched(mark); return }
      const snapshot = await loadBookSnapshot(cache, mark.bookId, targetEditionKey)
      if (!isCurrent()) return
      const sameEdition = targetEditionKey === mark.editionKey && snapshot.toc.sourceFingerprint === mark.sourceFingerprint
      let chapter = sameEdition ? snapshot.toc.chapters.find((c) => c.chapterUrl === mark.chapterUrl && c.isVolume !== true) : undefined
      if (!chapter) {
        const titleKey = normalizeChapterTitle(mark.chapterTitle)
        let candidates = snapshot.toc.chapters.filter((candidate) => candidate.isVolume !== true && normalizeChapterTitle(candidate.title) === titleKey)
        if (candidates.length > 1) candidates = candidates.filter((candidate) => candidate.index === mark.chapterIndex)
        if (candidates.length === 1) chapter = candidates[0]
      }
      if (!chapter) { showUnmatched(mark); return }
      const content = (await apiFetch<{ content: { content: ApiContent } }>(`/api/books/${encodeURIComponent(mark.bookId)}/chapters/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(targetEditionKey)}`, { signal: controller.signal })).content.content
      if (!isCurrent()) return
      cache.setContent(mark.bookId, targetEditionKey, chapter.chapterId, content)
      const texts = chapterTexts(content)
      const anchor = resolveAnchor(texts, mark.anchor, textFingerprint(content.cleaned))
      if (kind === 'annotations' && !anchor) { showUnmatched(mark); return }
      const destination: ReaderMarkDestination = { path: `/books/${encodeURIComponent(mark.bookId)}/read/${encodeURIComponent(chapter.chapterId)}?editionKey=${encodeURIComponent(targetEditionKey)}`, editionKey: targetEditionKey, chapterId: chapter.chapterId, point: anchor?.start ?? { paragraphIndex: 0, offset: 0 } }
      if (onNavigate) { onNavigate(destination); return }
      const originEditionKey = activeEditions?.[mark.bookId]
      const origin = originEditionKey ? { path: `/books/${encodeURIComponent(mark.bookId)}/read?editionKey=${encodeURIComponent(originEditionKey)}`, editionKey: originEditionKey, state: pageReturnState(location) } : undefined
      navigate(destination.path, { state: { ...pageReturnState(location), readingPreview: { target: { editionKey: destination.editionKey, chapterId: destination.chapterId, point: destination.point }, ...(origin ? { origin } : {}) } } });
    } catch (reason) {
      if (isCurrent()) {
        setMissing(null); setRetryMark(item)
        setError(reason instanceof Error ? reason.message : '正文加载失败，请重试。')
      }
    } finally {
      if (openController.current === controller) openController.current = null
      if (isCurrent()) setBusy(null)
    }
  }
  async function more() {
    if (!cursor) return
    setBusy('more'); setError(''); const ownGeneration = generation.current
    try {
      const result = await apiFetch<MarkSummaryPage>(path + '&cursor=' + encodeURIComponent(cursor)); if (ownGeneration !== generation.current || !active.current) return
      const old = cachedMarkPages.get(cacheKey)?.items ?? items; const next = [...old, ...result.items.filter((r) => !old.some((i) => i.id === r.id))]
      cachedMarkPages.set(cacheKey, { items: next, cursor: result.nextCursor }); setItems(next); setCursor(result.nextCursor)
    } catch (reason) { if (ownGeneration === generation.current && active.current) setError(reason instanceof Error ? reason.message : '加载失败') } finally { if (ownGeneration === generation.current && active.current) setBusy(null) }
  }
  return <div className={`reading-marks-list${cardLayout ? ' reading-marks-list-global' : ''}${readerSheet ? ' reading-marks-list-reader-sheet' : ''}${empty ? ' reading-marks-list-empty' : ''}`}>
    {readerSheet && kind === 'bookmarks' && currentProgressTitle !== undefined ? <button className="reader-current-progress" type="button" onClick={onCurrentProgress}><span>当前进度</span><strong>{currentProgressTitle}</strong></button> : null}
    {error ? <div className="notice-with-recovery"><DismissibleMessage className="error" role="alert" onDismiss={() => { setError(''); setMissing(null); setRetryMark(null) }}>{error}{missing?.hasCachedChapter && kind === 'annotations' ? <button className="text-button" type="button" onClick={() => setCachePreview(missing)}>查看缓存</button> : null}</DismissibleMessage><button className="text-button" onClick={() => retryMark ? void open(retryMark) : reload()} type="button">{retryMark ? '重试打开' : '重新加载'}</button></div> : null}
    {loading ? <LoadingState message="正在读取记录…" /> : empty ? <EmptyState icon={EmptyIcon} title={emptyTitle} description={emptyDescription} /> : null}
    {items.map((mark) => {
      const restoreLabel = kind === 'bookmarks' ? '恢复书签' : '恢复笔记'
      const showMenu = global || readerSheet
      return <div className="reading-mark-item" key={mark.id} data-color={mark.color}>
        <div className="reading-mark-meta"><strong>{global ? mark.bookName : mark.chapterTitle}{!global && mark.deletedAt ? <span className="reading-mark-deleted-dot" role="img" aria-label="已删除" title="已删除" /> : null}</strong><div className="reading-mark-meta-trailing"><time dateTime={mark.createdAt}>{new Date(mark.createdAt).toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>{showMenu ? <MoreMenu label={`更多${kind === 'bookmarks' ? '书签' : '笔记'}操作：${mark.chapterTitle}`}>
          {mark.deletedAt ? <><button className="more-menu-item" type="button" disabled={busy !== null || purging !== null} onClick={() => void action(mark, true)}><RotateCcw aria-hidden="true" />{restoreLabel}</button>{kind === 'annotations' ? <button className="more-menu-item" type="button" onClick={() => void showMarkDetails(mark, 'preview')}><FileText aria-hidden="true" />查看原文</button> : null}{global ? <button className="more-menu-item danger-action" type="button" disabled={busy !== null || purging !== null} onClick={() => setPendingPurge(mark)}><Trash2 aria-hidden="true" />彻底删除</button> : null}</> : <>{kind === 'annotations' ? <><button className="more-menu-item" type="button" disabled={busy !== null} onClick={() => void showMarkDetails(mark, 'edit')}><Pencil aria-hidden="true" />编辑笔记</button><button className="more-menu-item" type="button" onClick={() => void showMarkDetails(mark, 'preview')}><FileText aria-hidden="true" />查看原文</button></> : null}<button className="more-menu-item danger-action" type="button" disabled={busy !== null} onClick={() => void action(mark, false)}><Trash2 aria-hidden="true" />{kind === 'bookmarks' ? '删除书签' : '删除笔记'}</button></>}
        </MoreMenu> : null}</div></div>
        {cardLayout ? <div className="reading-mark-quote">{global ? <span className="reading-mark-chapter">{mark.chapterTitle}{mark.deletedAt ? <span className="reading-mark-deleted-dot" role="img" aria-label="已删除" title="已删除" /> : null}</span> : null}<button type="button" className="reading-mark-excerpt" disabled={busy !== null || deleted || purging !== null} onClick={() => void open(mark)}>{mark.excerpt}</button></div> : <button type="button" className="reading-mark-excerpt" disabled={busy !== null || deleted || purging !== null} onClick={() => void open(mark)}>{mark.excerpt}</button>}
        {mark.note ? <p className="reading-mark-note"><MessageSquare aria-hidden="true" />{mark.note}</p> : null}
        {global || readerSheet ? null : <div className="reading-mark-footer"><div className="reading-mark-actions">{deleted ? <div className="reading-mark-edit-actions"><Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void action(mark, true)}><RotateCcw aria-hidden="true" />{restoreLabel}</Button>{kind === 'annotations' ? <Button variant="secondary" size="sm" onClick={() => void showMarkDetails(mark, 'preview')}><FileText aria-hidden="true" />查看原文</Button> : null}</div> : <>{kind === 'annotations' ? <div className="reading-mark-edit-actions"><Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void showMarkDetails(mark, 'edit')}><Pencil aria-hidden="true" />编辑笔记</Button><Button variant="secondary" size="sm" onClick={() => void showMarkDetails(mark, 'preview')}><FileText aria-hidden="true" />查看原文</Button></div> : null}<Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void action(mark, false)}><Trash2 aria-hidden="true" />{kind === 'bookmarks' ? '删除书签' : '删除笔记'}</Button></>}</div></div>}
      </div>
    })}
    {cursor ? <Button variant="secondary" disabled={busy !== null || loading} onClick={() => void more()}>加载更多</Button> : null}
    <Sheet open={pendingPurge !== null} title="确认彻底删除笔记" onOpenChange={(open) => { if (!open) setPendingPurge(null) }}><p>彻底删除后无法恢复。</p><p>书籍：《{pendingPurge?.bookName}》</p><p>原文：“{pendingPurge?.excerpt.slice(0, 100)}{pendingPurge && pendingPurge.excerpt.length > 100 ? '…' : ''}”</p><p>确定彻底删除这条笔记吗？</p><div className="actions"><Button variant="secondary" onClick={() => setPendingPurge(null)}>取消</Button><Button onClick={() => { if (pendingPurge) { const mark = pendingPurge; setPendingPurge(null); void purge(mark) } }}>彻底删除</Button></div></Sheet>
    <DialogPresence>{editing ? <ReadingMarkEditor key={editing.id} initialNote={editing.note ?? ''} onClose={() => setEditing(null)} onSave={async (note) => { const input = markSaveInput(editing); const result = await apiFetch<{ item: ReadingMarkListItem }>(itemPath(editing) + '?view=list', { method: 'PUT', body: JSON.stringify({ ...input, note, expectedVersion: editing.version }) }, userId); const cached = cachedMarkPages.get(cacheKey); const next = (cached?.items ?? items).map((item) => item.id === result.item.id ? result.item : item); const page = { items: next, cursor: cached?.cursor ?? cursor }; cachedMarkPages.set(cacheKey, page); if (readerSheet) cachedMarkPages.set(`${userId ?? ''}:${Number(notesVersion) + 1}:${path}`, page); setItems(next) }} /> : null}</DialogPresence>
    <Sheet className="cached-chapter-sheet" open={cachePreview !== null} onOpenChange={(open) => { if (!open) setCachePreview(null) }} title="当时的章节内容">{previewLoading ? <LoadingState message="正在读取原文…" /> : previewError ? <DismissibleMessage className="error" role="alert" onDismiss={() => setPreviewError('')}>{previewError}<Button variant="secondary" onClick={() => setPreviewRetry((value) => value + 1)}>重试</Button></DismissibleMessage> : cachePreview ? <CachedChapterPreview mark={cachePreview} cached={previewChapter} fontSize={settings.fontSize} lineHeight={settings.lineHeight} /> : null}</Sheet>
  </div>
}

function normalizeChapterTitle(value: string) { return value.trim().replace(/\s+/gu, '').toLocaleLowerCase() }
function chapterTexts(content: ApiContent) {
  return readingParagraphTexts(readingDocument({ ...content, baseUrl: content.finalUrl ?? content.chapter.chapterUrl }))
}

function CachedChapterPreview({ mark, cached, fontSize, lineHeight }: { mark: MarkDetails; cached: CachedChapter | null; fontSize: number; lineHeight: number }) {
  const centerMarked = useRef<HTMLElement>(null)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => centerMarked.current?.scrollIntoView({ block: 'center', behavior: 'auto' }))
    return () => window.cancelAnimationFrame(frame)
  }, [mark.id, cached])
  if (!cached) return <p className="muted">这条笔记没有可用的章节缓存。</p>
  const absolute = (point: TextPoint) => cached.paragraphs.slice(0, point.paragraphIndex).reduce((total, paragraph) => total + paragraph.length + 1, 0) + point.offset
  const markCenter = (absolute(cached.start) + absolute(cached.end)) / 2
  let paragraphStart = 0
  return <div className="cached-chapter-preview">
    <p className="cached-chapter-origin muted small">{mark.sourceName} · {mark.chapterTitle}</p>
    <article className="reader-content cached-chapter-reader" style={{ fontSize: `${fontSize}px`, lineHeight }}>
      {cached.truncatedBefore ? <p className="cached-chapter-ellipsis" aria-label="前文已裁剪">…</p> : null}
      {cached.paragraphs.map((paragraph, index) => {
        const inRange = index >= cached.start.paragraphIndex && index <= cached.end.paragraphIndex
        const from = index === cached.start.paragraphIndex ? cached.start.offset : 0
        const to = index === cached.end.paragraphIndex ? cached.end.offset : paragraph.length
        const selected = inRange && to > from
        const pointAtCenter = markCenter >= paragraphStart + from && markCenter <= paragraphStart + to
        paragraphStart += paragraph.length + 1
        return <p className="reader-paragraph" data-paragraph={index} key={`${index}:${paragraph.slice(0, 12)}`}>
          {selected ? <>{paragraph.slice(0, from)}<span ref={pointAtCenter ? centerMarked : undefined} className="reader-mark cached-chapter-highlight" data-color={mark.color}>{paragraph.slice(from, to)}</span>{paragraph.slice(to)}</> : paragraph}
        </p>
      })}
      {cached.truncatedAfter ? <p className="cached-chapter-ellipsis" aria-label="后文已裁剪">…</p> : null}
    </article>
  </div>
}
