import { PageHeader } from '../components/page-header.tsx'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { normalizeIdentity, sameBookIdentity } from '../../shared/book-identity.ts'
import type { BookDetailsResponse } from '../../shared/book-details.ts'
import type { BookSourceItem, BookSourcesResponse } from '../../shared/book-sources.ts'
import { PageBackButton } from '../components/page-back-button.tsx'
import { LoadingState } from '../components/loading-state.tsx'
import { PrecisionToggle } from '../components/precision-toggle.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { apiFetch, type ApiChapter, type ApiEdition, type ApiPosition } from '../lib/api.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { loadBookSnapshot } from '../lib/book-cache.ts'
import { pageReturnState, readingEntryState } from '../lib/page-navigation.ts'
import { useBookSearch } from '../lib/use-book-search.ts'
import { fallbackChapterForPosition } from '../lib/source-position.ts'
import { groupBookSourcesByDomain } from '../lib/book-source-groups.ts'
import { formatSourceRuleDateTime } from '../lib/time-format.ts'
import { compareSourceManagementOrder, selectOneSourcePerDomain, sourceDomainInfo } from '../../shared/source-domain.ts'
import type { ManagedSourceSummary, SourceManagementPage } from '../../shared/source-management.ts'

export function BookSourcesPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const cache = useBookCache()
  const [book, setBook] = useState<BookDetailsResponse['book'] | null>(null)
  const [data, setData] = useState<BookSourcesResponse | null>(null)
  const [keyword, setKeyword] = useState('')
  const [precision, setPrecision] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [switchingSourceId, setSwitchingSourceId] = useState<string | null>(null)
  const [managedSources, setManagedSources] = useState<ManagedSourceSummary[]>([])
  const [pendingSwitch, setPendingSwitch] = useState<PendingSourceSwitch | null>(null)
  const [retry, setRetry] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const { candidates, searchId, status, message, progress, cancellationPending, search, replaceSearch, cancelAndWait, cancel } = useBookSearch()
  const prefix = '/books/' + encodeURIComponent(bookId)
  const managedSourceById = useMemo(() => new Map(managedSources.map((source) => [source.sourceId, source])), [managedSources])
  const accountDefaults = useMemo(() => new Map(selectOneSourcePerDomain(managedSources.filter((source) => source.enabled), compareSourceManagementOrder).map((source) => [sourceDomainInfo(source.sourceId).key, source])), [managedSources])
  const results = useMemo(() => {
    const known = new Set(data?.sources.map((source) => JSON.stringify([source.sourceId, source.sourceFingerprint, source.bookUrl])) ?? [])
    return candidates.flatMap((item, index) => {
      if (book === null) return []
      const matches = book.author?.trim().length && book.author !== '作者未知'
        ? sameBookIdentity(book.name, book.author, item.candidate.name, item.candidate.author)
        : normalizeIdentity(book.name) === normalizeIdentity(item.candidate.name ?? '')
      const key = JSON.stringify([item.sourceId, item.sourceFingerprint, item.candidate.bookUrl])
      if (!matches || known.has(key)) return []
      known.add(key)
      return [{ item, index }]
    })
  }, [book, candidates, data?.sources])
  const bookSourceGroups = useMemo(() => groupBookSourcesByDomain(managedSources, data?.sources ?? [], results.map(({ item, index }) => ({ sourceId: item.sourceId, index, item }))), [data?.sources, managedSources, results])

  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller
    setOpening(null); setSwitchingSourceId(null); setPendingSwitch(null)
    return () => controller.abort()
  }, [])
  usePageLoadEffect((settle) => {
    const controller = new AbortController()
    setError(''); setNotice('')
    void Promise.all([
      apiFetch<BookDetailsResponse>('/api' + prefix + '/details', { signal: controller.signal }),
      apiFetch<BookSourcesResponse>('/api' + prefix + '/sources', { signal: controller.signal }),
      apiFetch<SourceManagementPage>('/api/source-management?all=true', { signal: controller.signal }),
    ]).then(([details, sources, sourceManagement]) => {
      if (controller.signal.aborted) return
      setBook(details.book); setData(sources); setManagedSources(sourceManagement.sources); setKeyword((previous) => previous || details.book.name)
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '书源加载失败') })
      .finally(() => { if (!controller.signal.aborted) settle() })
    return () => controller.abort()
  }, [prefix, retry], ['books', 'sources', 'candidates', `book:${bookId}`])

  async function refreshSourceLists(signal?: AbortSignal) {
    const [sourceManagement, sources] = await Promise.all([
      apiFetch<SourceManagementPage>('/api/source-management?all=true', { signal: signal ?? null }),
      apiFetch<BookSourcesResponse>('/api' + prefix + '/sources', { signal: signal ?? null }),
    ])
    if (signal?.aborted) return
    setManagedSources(sourceManagement.sources)
    setData(sources)
  }

  async function ensureSourceActive(sourceId: string, signal?: AbortSignal) {
    const source = managedSourceById.get(sourceId)
    if (source === undefined) throw new Error('书源已删除或需要重新导入')
    if (accountDefaults.get(sourceDomainInfo(sourceId).key)?.sourceId === sourceId) return
    await cancelAndWait()
    if (signal?.aborted) return
    await apiFetch('/api/source-management/actions', { method: 'POST', signal: signal ?? null, body: JSON.stringify({ action: 'enable', items: [{ sourceId, expectedSourceRevision: source.sourceRevision }] }) })
    await refreshSourceLists(signal)
  }

  async function setAccountDefault(sourceId: string) {
    if (switchingSourceId !== null || opening !== null) return
    const controller = controllerRef.current
    const signal = controller?.signal
    setSwitchingSourceId(sourceId); setError(''); setNotice('正在切换账号默认书源…')
    try {
      await ensureSourceActive(sourceId, signal)
      if (!signal?.aborted) setNotice(`${managedSourceById.get(sourceId)?.name ?? sourceId} 已设为账号默认版本。`)
    } catch (reason) { if (!signal?.aborted) { setError(reason instanceof Error ? reason.message : '切换默认书源失败'); setNotice('') } }
    finally { if (!signal?.aborted) setSwitchingSourceId(null) }
  }

  async function searchThisBookWithSource(sourceId: string) {
    if (opening !== null || switchingSourceId !== null || book === null) return
    const signal = controllerRef.current?.signal
    setOpening('search-source:' + sourceId); setError(''); setNotice('正在启用书源并搜索这本书…')
    try {
      await ensureSourceActive(sourceId, signal)
      if (signal?.aborted) return
      const searched = await replaceSearch(book.name, precision, [sourceId])
      if (!signal?.aborted) {
        if (searched) setNotice(`已用 ${managedSourceById.get(sourceId)?.name ?? sourceId} 搜索，请在“本次搜索”结果中打开或切换到匹配版本。`)
        else { setNotice(''); setError('这次书源搜索未完成，请重试。') }
      }
    } catch (reason) { if (!signal?.aborted) { setNotice(''); setError(reason instanceof Error ? reason.message : '书源搜索失败') } }
    finally { if (!signal?.aborted) setOpening(null) }
  }

  async function open(key: string, sourceId: string, action: 'directory' | 'switch', resolveEdition: () => Promise<string>) {
    if (opening !== null) return
    const signal = controllerRef.current?.signal
    setOpening(key); setError('')
    try {
      await ensureSourceActive(sourceId, signal)
      if (signal?.aborted) return
      const editionKey = await resolveEdition()
      if (signal?.aborted) return
      const query = '?editionKey=' + encodeURIComponent(editionKey)
      if (action === 'directory') {
        navigate(prefix + '/toc' + query, { state: pageReturnState(location) })
        return
      }
      const targetSnapshot = await loadBookSnapshot(cache, bookId, editionKey)
      if (signal?.aborted) return
      const targetChapters = targetSnapshot.toc.chapters.filter((chapter) => chapter.isVolume !== true)
      const currentEditionKey = book?.activeEditionKey ?? data?.activeEditionKey
      if (currentEditionKey === undefined || currentEditionKey === editionKey) {
        const position = await apiFetch<{ position: ApiPosition | null }>('/api' + prefix + '/position' + query, signal === undefined ? {} : { signal })
        const target = targetChapters.find((chapter) => chapter.chapterId === position.position?.chapterId) ?? targetChapters[0]
        if (target === undefined) throw new Error('目录中没有可阅读的章节')
        cache.setPosition(bookId, editionKey, position.position)
        navigate(prefix + '/read/' + encodeURIComponent(target.chapterId) + query, { state: readingEntryState(location) })
      } else {
        const mapped = await mapSourcePosition(bookId, currentEditionKey, editionKey, cache, targetChapters, signal)
        if (mapped.target === undefined) throw new Error('目标来源目录中没有可阅读的章节')
        setPendingSwitch({ key, editionKey, target: mapped.target, targetRevision: targetSnapshot.toc.revision, currentTitle: mapped.currentTitle, matched: mapped.matched, targetPosition: mapped.targetPosition })
      }
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '来源加载失败') }
    finally { if (!signal?.aborted) setOpening(null) }
  }

  function openSource(source: BookSourceItem, action: 'directory' | 'switch') {
    const key = source.status === 'saved' ? source.editionKey : source.candidateId
    void open(key, source.sourceId, action, async () => source.status === 'saved' ? source.editionKey : (await apiFetch<{ edition: ApiEdition }>('/api' + prefix + '/sources/' + encodeURIComponent(source.candidateId) + '/open', { method: 'POST', signal: controllerRef.current?.signal ?? null })).edition.editionKey)
  }
  function openSearchCandidate(index: number, action: 'directory' | 'switch') {
    const candidate = candidates[index]
    if (candidate === undefined) return
    void open('search:' + index, candidate.sourceId, action, async () => (await apiFetch<{ edition: ApiEdition }>('/api/books', { method: 'POST', signal: controllerRef.current?.signal ?? null, body: JSON.stringify({ searchId, candidateIndex: index, candidateIdentity: { sourceId: candidate.sourceId, sourceFingerprint: candidate.sourceFingerprint, bookUrl: candidate.candidate.bookUrl }, bookId, addToBookshelf: false, activateEdition: false }) })).edition.editionKey)
  }

  async function confirmSwitch() {
    const pending = pendingSwitch
    if (pending === null || opening !== null) return
    const signal = controllerRef.current?.signal
    setOpening(pending.key); setError('')
    try {
      const query = '?editionKey=' + encodeURIComponent(pending.editionKey)
      await apiFetch('/api' + prefix + '/edition', { method: 'PUT', signal: signal ?? null, body: JSON.stringify({ editionKey: pending.editionKey }) })
      const saved = await apiFetch<{ position: ApiPosition } | { position: null }>('/api' + prefix + '/position', { method: 'POST', signal: signal ?? null, body: JSON.stringify({ editionKey: pending.editionKey, chapterId: pending.target.chapterId, chapterUrl: pending.target.chapterUrl, chapterIndex: pending.target.index, title: pending.target.title, tocRevision: pending.targetRevision, paragraphIndex: 0, offset: 0, version: (pending.targetPosition?.version ?? -1) + 1 }) })
      if (signal?.aborted) return
      const position = saved.position
      cache.setPosition(bookId, pending.editionKey, position)
      setPendingSwitch(null)
      navigate(prefix + '/read/' + encodeURIComponent(pending.target.chapterId) + query, { state: readingEntryState(location) })
    } catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : '切换书源失败') }
    finally { if (!signal?.aborted) setOpening(null) }
  }

  const groupedResultDomains = new Set(bookSourceGroups.map((group) => group.domainKey))
  const ungroupedResults = results.filter(({ item }) => !groupedResultDomains.has(sourceDomainInfo(item.sourceId).key))
  const fallback = prefix + '/toc' + (book?.activeEditionKey ? '?editionKey=' + encodeURIComponent(book.activeEditionKey) : '')
  return <section className="page-stack page-narrow book-sources-page">
    {cancellationPending ? <p className="error" role="alert">搜索取消尚未完成。<Button variant="secondary" size="sm" onClick={() => void cancel()}>重试取消</Button></p> : null}
    <PageHeader backTo={fallback} title="切换书源" description={book?.name ?? '书籍来源'} />
    {error.length > 0 ? <p className="error" role="alert">{error}<Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>重试列表</Button></p> : null}
    {data === null ? error.length === 0 ? <LoadingState message="正在读取可用书源…" variant="viewport" action={<PageBackButton appearance="button" fallback={fallback} />} /> : null : <>
      <form className="book-source-search" onSubmit={(event) => { event.preventDefault(); setNotice(''); void search(keyword, precision) }}><div className="search-row"><Input aria-label="搜索可用书源" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名" /><PrecisionToggle checked={precision} disabled={status === 'loading'} onChange={setPrecision} /><Button className={status === 'loading' ? 'cancel-button-active' : 'cancel-button'} variant={status === 'loading' ? 'secondary' : 'default'} type={status === 'loading' ? 'button' : 'submit'} disabled={status !== 'loading' && keyword.trim().length === 0} onClick={status === 'loading' ? () => void cancel() : undefined}>{status === 'loading' ? '取消' : '搜索'}</Button></div><p className="muted small">切换会更新账号默认书源；目录预览不会改本书当前版本。</p></form>
      {notice.length > 0 ? <p className="success compact-message" role="status">{notice}</p> : null}
      {message.length > 0 ? <p className="muted small" role="status">{message}</p> : null}
      {status === 'loading' ? <LoadingState message={'正在搜索可用书源…' + (progress === undefined ? '' : ` 书源 ${progress.completed}/${progress.total}`)} variant={data.sources.length === 0 && results.length === 0 ? 'content' : 'inline'} /> : null}
      {status === 'done' && searchId.length > 0 && results.length === 0 ? <div className="empty-state">当前搜索没有找到与这本书匹配的来源。</div> : null}
      <div className="book-source-list">
        {bookSourceGroups.length === 0 && results.length === 0 && status !== 'loading' ? <div className="empty-state">没有关联书源，请搜索书名或为某个域名版本搜索。</div> : null}
        {bookSourceGroups.map((group) => {
          const latest = group.versions[0]?.source
          const defaultVersion = group.versions.find((version) => version.isAccountDefault)?.source
          const enabledCount = group.versions.filter((version) => version.source.enabled).length
          const activeBookEditionInGroup = group.versions.some((version) => version.items.some((source) => source.status === 'saved' && source.editionKey === data.activeEditionKey))
          return <article className="book-source-domain" key={group.domainKey}>
            <details className="book-source-domain-details" open={activeBookEditionInGroup}>
              <summary className="book-source-domain-summary"><span className="book-source-domain-heading"><span className="book-source-domain-title">{enabledCount > 1 ? <span className="badge source-domain-warning">存在多个旧启用项</span> : defaultVersion === undefined ? <span className="badge source-disabled">暂无账号默认版本</span> : <span className="badge source-enabled">默认：{group.versions.find((version) => version.source.sourceId === defaultVersion.sourceId)?.displayName}</span>}<strong>{group.domain}</strong></span><span className="muted small">{group.versions.length} 个实现 · 最新规则 {formatSourceRuleDateTime(latest?.lastUpdateTime)}</span></span></summary>
              <div className="book-source-domain-versions">{group.versions.map((version) => {
                const { source, displayName, items, searchResults: versionResults, isAccountDefault } = version
                const searching = opening === 'search-source:' + source.sourceId
                return <section className="book-source-version" key={source.sourceId}>
                  <div className="book-source-version-header"><div className="book-source-info"><div className="book-source-version-title"><strong>{displayName}</strong><Button className="book-source-default-button" variant="secondary" size="sm" disabled={opening !== null || switchingSourceId !== null || isAccountDefault} onClick={() => void setAccountDefault(source.sourceId)}>{switchingSourceId === source.sourceId ? '切换中…' : isAccountDefault ? '账号默认' : '设为账号默认'}</Button></div><p className="muted small" title={source.sourceId}>{source.sourceId}</p><span className="muted small">规则更新时间 {formatSourceRuleDateTime(source.lastUpdateTime)} · {source.enabled ? isAccountDefault ? '账号默认' : '旧启用项' : '已停用'}</span></div>{items.length === 0 && versionResults.length === 0 ? <div className="book-source-actions"><Button size="sm" disabled={opening !== null || switchingSourceId !== null || status === 'loading'} onClick={() => void searchThisBookWithSource(source.sourceId)}>{searching ? '搜索中…' : '用此版本搜索本书'}</Button></div> : null}</div>
                  {items.length === 0 && versionResults.length === 0 ? <p className="book-source-unsearched muted small">尚未搜索这本书。搜索会只使用这个实现，并将它设为账号默认版本。</p> : null}
                  {items.map((item) => {
                    const current = item.status === 'saved' && item.editionKey === data.activeEditionKey
                    const key = item.status === 'saved' ? item.editionKey : item.candidateId
                    const canSwitch = !current || !isAccountDefault
                    return <article className={'book-source-row book-source-entry' + (current ? ' current' : '')} key={key}><div className="book-source-info"><strong>{item.status === 'saved' ? '已保存版本' : '已发现候选'}</strong><p className="muted small" title={item.bookUrl}>{item.bookUrl}</p><span className="muted small">{current ? '本书当前版本' : item.status === 'saved' ? '已保存' : '已发现'} · {item.sourceEnabled ? '可用' : '账号已停用'}</span></div><div className="book-source-actions"><Button variant="secondary" size="sm" disabled={opening !== null || switchingSourceId !== null} onClick={() => openSource(item, 'directory')}>查看目录</Button><Button size="sm" disabled={!canSwitch || opening !== null || switchingSourceId !== null} onClick={() => openSource(item, 'switch')}>{opening === key ? '加载中…' : current && !isAccountDefault ? '恢复并继续阅读' : current ? '当前使用' : '切换书源'}</Button></div></article>
                  })}
                  {versionResults.map(({ item, index }) => <article className="book-source-row book-source-entry" key={'search:' + index}><div className="book-source-info"><strong>本次搜索结果</strong><p className="muted small" title={item.candidate.bookUrl}>{item.candidate.bookUrl}</p><span className="muted small">已匹配本书 · 当前搜索结果</span></div><div className="book-source-actions"><Button variant="secondary" size="sm" disabled={opening !== null || switchingSourceId !== null} onClick={() => openSearchCandidate(index, 'directory')}>查看目录</Button><Button size="sm" disabled={opening !== null || switchingSourceId !== null} onClick={() => openSearchCandidate(index, 'switch')}>{opening === 'search:' + index ? '加载中…' : '切换书源'}</Button></div></article>)}
                </section>
              })}</div>
            </details>
          </article>
        })}
        {ungroupedResults.map(({ item, index }) => <article className="book-source-row" key={'search:' + index}><div className="book-source-info"><strong>{managedSourceById.get(item.sourceId)?.name ?? item.sourceId}</strong><p className="muted small" title={item.candidate.bookUrl}>{item.candidate.bookUrl}</p><span className="muted small">本次搜索 · {sourceDomainInfo(item.sourceId).domain}</span></div><div className="book-source-actions"><Button variant="secondary" size="sm" disabled={opening !== null || switchingSourceId !== null} onClick={() => openSearchCandidate(index, 'directory')}>查看目录</Button><Button size="sm" disabled={opening !== null || switchingSourceId !== null} onClick={() => openSearchCandidate(index, 'switch')}>{opening === 'search:' + index ? '加载中…' : '切换书源'}</Button></div></article>)}
      </div>
    </>}
    <Sheet open={pendingSwitch !== null} onOpenChange={(open) => { if (!open) setPendingSwitch(null) }} title="确认切换书源"><div className="source-switch-confirm">{pendingSwitch === null ? null : <><p>将切换到“{pendingSwitch.target.title}”。{pendingSwitch.matched ? `已按“${pendingSwitch.currentTitle}”匹配。` : '没有找到同名章节，将按章节序号定位。'}</p><div className="actions"><Button type="button" onClick={() => void confirmSwitch()} disabled={opening !== null}>确认切换</Button><Button type="button" variant="secondary" onClick={() => setPendingSwitch(null)}>取消</Button></div></>}</div></Sheet>
    <Link className="sr-only" to={fallback}>本书目录</Link>
  </section>
}

interface PendingSourceSwitch { key: string; editionKey: string; target: ApiChapter; targetRevision: string; currentTitle: string | undefined; matched: boolean; targetPosition: ApiPosition | null }

async function mapSourcePosition(bookId: string, currentEditionKey: string, targetEditionKey: string, cache: ReturnType<typeof useBookCache>, targetChapters: ApiChapter[], signal?: AbortSignal): Promise<{ target: ApiChapter | undefined; currentTitle: string | undefined; matched: boolean; targetPosition: ApiPosition | null }> {
  const [currentSnapshot, currentPosition, targetPosition] = await Promise.all([
    loadBookSnapshot(cache, bookId, currentEditionKey),
    apiFetch<{ position: ApiPosition | null }>('/api/books/' + encodeURIComponent(bookId) + '/position?editionKey=' + encodeURIComponent(currentEditionKey), signal === undefined ? {} : { signal }),
    apiFetch<{ position: ApiPosition | null }>('/api/books/' + encodeURIComponent(bookId) + '/position?editionKey=' + encodeURIComponent(targetEditionKey), signal === undefined ? {} : { signal }),
  ])
  const currentChapter = currentSnapshot.toc.chapters.find((chapter) => chapter.isVolume !== true && chapter.chapterId === currentPosition.position?.chapterId)
  const currentTitle = currentChapter?.title ?? currentPosition.position?.title
  const normalizedTitle = currentTitle === undefined ? '' : normalizeChapterTitle(currentTitle)
  const matchedChapter = normalizedTitle.length === 0 ? undefined : targetChapters.find((chapter) => normalizeChapterTitle(chapter.title) === normalizedTitle)
  const fallbackIndex = currentChapter?.index ?? currentPosition.position?.chapterIndex ?? 0
  const target = matchedChapter ?? fallbackChapterForPosition(targetChapters, fallbackIndex)
  return { target, currentTitle, matched: matchedChapter !== undefined, targetPosition: targetPosition.position }
}

function normalizeChapterTitle(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }
