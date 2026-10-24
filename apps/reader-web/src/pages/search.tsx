import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { BookListPicker } from '../components/book-list-picker.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { usePageActivity, usePageLoadEffect } from '../lib/use-page-resource.ts'
import { normalizeIdentity, sameBookIdentity } from '../../shared/book-identity.ts'
import { searchMatchRank } from '@legado/source-core'
import type { SourceCacheWarning } from '../../shared/book-sources.ts'
import { candidateSelectionKey, selectedCandidateIndex } from '../lib/search-selection.ts'
import { useBookSearch } from '../lib/use-book-search.ts'
import { formatSourceRuleDateTime } from '../lib/time-format.ts'
import { pageReturnState } from '../lib/page-navigation.ts'
import { LoadingState } from '../components/loading-state.tsx'
import { PrecisionToggle } from '../components/precision-toggle.tsx'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { apiFetch, type ApiBook, type ApiCandidate, type ApiHome } from '../lib/api.ts'
import { compareSourceManagementOrder, groupSourcesByDomain, selectOneSourcePerDomain, sourceDomainInfo, type SourceDomainGroup } from '../../shared/source-domain.ts'
import type { ManagedSourceSummary, SourceManagementPage } from '../../shared/source-management.ts'

interface CandidateGroup {
  key: string
  name: string
  author: string
  items: Array<{ item: ApiCandidate; index: number }>
}

export function SearchPage() {
  const page = usePageActivity()
  const [visibleCount, setVisibleCount] = useState(50)
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const queryKeyword = searchParams.get('q') ?? ''
  const [listCandidate, setListCandidate] = useState<{ group: CandidateGroup; identity: string; searchId: string } | null>(null)
  const targetBookListId = searchParams.get('targetBookListId') ?? ''
  const targetBookId = searchParams.get('bookId') ?? ''
  const [books, setBooks] = useState<ApiBook[]>([])
  const [shelfBooks, setShelfBooks] = useState<ApiBook[]>([])
  const [booksLoaded, setBooksLoaded] = useState(false)
  const [precision, setPrecision] = useState(false)
  const [keyword, setKeyword] = useState(queryKeyword)
  const { candidates, searchId, status, message: searchMessage, progress, cancellationPending, search, replaceSearch, cancelAndWait, cancel, resume } = useBookSearch()
  const [expandedKey, setExpandedKey] = useState<string>()
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [saving, setSaving] = useState<number | null>(null)
  const [managedSources, setManagedSources] = useState<ManagedSourceSummary[]>([])
  const [sourceManagementError, setSourceManagementError] = useState('')
  const [switchingSourceId, setSwitchingSourceId] = useState<string | null>(null)
  const sourceSwitchRef = useRef<AbortController | null>(null)
  const saveController = useRef<AbortController | null>(null)
  useEffect(() => () => { saveController.current?.abort(); sourceSwitchRef.current?.abort() }, [])
  const managedGroups = useMemo(() => groupSourcesByDomain(managedSources), [managedSources])
  const managedSourceById = useMemo(() => new Map(managedSources.map((source) => [source.sourceId, source])), [managedSources])
  const managedGroupByKey = useMemo(() => new Map(managedGroups.map((group) => [group.domainKey, group])), [managedGroups])
  const groups = useMemo(() => {
    const all = groupCandidates(candidates)
    if (targetBookId.length > 0 && !booksLoaded) return []
    const target = targetBookId.length === 0 ? undefined : books.find((book) => book.id === targetBookId)
    if (targetBookId.length > 0 && target === undefined) return []
    return target === undefined ? all : all.filter((group) => target.author?.trim().length && target.author !== '作者未知' ? sameBookIdentity(target.name, target.author, group.name, group.author) : normalizeIdentity(target.name) === normalizeIdentity(group.name))
  }, [books, booksLoaded, candidates, targetBookId])

  usePageLoadEffect((settle) => {
    let active = true
    void Promise.all([apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books'), apiFetch<ApiHome>('/api/home')]).then(([result, home]) => {
      if (active) { setBooks(result.books.map((item) => item.book)); setShelfBooks(home.bookshelf.map((item) => item.book)); setBooksLoaded(true) }
    }).catch((error: unknown) => {
      if (active) { setBooksLoaded(true); setMessageTone('error'); setMessage(error instanceof Error ? `已有书籍加载失败，仍可搜索：${error.message}` : '已有书籍加载失败，仍可搜索') }
    })
      .finally(() => { if (active) settle() })
    return () => { active = false }
  }, [], ['candidates', 'home'])
  usePageLoadEffect((settle) => {
    let active = true
    void apiFetch<SourceManagementPage>('/api/source-management?all=true').then((result) => {
      if (active) { setManagedSources(result.sources); setSourceManagementError('') }
    }).catch((error: unknown) => {
      if (active) setSourceManagementError(error instanceof Error ? error.message : '书源列表加载失败')
    })
      .finally(() => { if (active) settle() })
    return () => { active = false }
  }, [], ['sources'])
  const previousQuery = useRef(queryKeyword)
  useEffect(() => { if (previousQuery.current !== queryKeyword) { previousQuery.current = queryKeyword; setKeyword(queryKeyword) } }, [queryKeyword])

  async function saveCandidate(group: CandidateGroup, action: 'shelf' | 'directory' | 'details' | 'list') {
    if (!booksLoaded || saveController.current !== null) return
    const selectedIndex = selectedCandidateIndex(group.items, selectedByGroup[group.key])
    if (selectedIndex === undefined || searchId.length === 0) return
    const result = candidates[selectedIndex]
    if (result === undefined) return
    if (action === 'list') { setListCandidate({ group, identity: candidateSelectionKey(result), searchId }); return }
    const requestedBook = targetBookId.length > 0 ? books.find((book) => book.id === targetBookId) : undefined
    const existingBook = requestedBook ?? books.find((book) => sameBookIdentity(book.name, book.author, result.candidate.name, result.candidate.author))
    const controller = new AbortController(); saveController.current = controller
    setSaving(selectedIndex); setMessageTone('info'); setMessage('')
    try {
      const created = await apiFetch<{ book: ApiBook; edition: { editionKey: string }; cacheWarning?: SourceCacheWarning }>('/api/books', { method: 'POST', signal: controller.signal, body: JSON.stringify({ searchId, candidateIndex: selectedIndex, candidateIdentity: { sourceId: result.sourceId, sourceFingerprint: result.sourceFingerprint, bookUrl: result.candidate.bookUrl }, addToBookshelf: action === 'shelf', activateEdition: action === 'shelf' || existingBook === undefined, ...(existingBook === undefined ? {} : { bookId: existingBook.id }) }) })
      if (controller.signal.aborted) return
      if (action !== 'shelf') {
        if (page?.active === false) return
        navigate(`/books/${encodeURIComponent(created.book.id)}/${action === 'details' ? 'details' : 'toc'}?editionKey=${encodeURIComponent(created.edition.editionKey)}${targetBookListId ? '&targetBookListId=' + encodeURIComponent(targetBookListId) : ''}`, { state: pageReturnState(location) })
      } else {
        setShelfBooks((current) => [...current.filter((book) => book.id !== created.book.id), created.book]); setBooks((current) => [...current.filter((book) => book.id !== created.book.id), created.book]); setMessageTone(created.cacheWarning === undefined ? 'success' : 'error'); setMessage(created.cacheWarning === undefined ? '已加入书架' : `书籍已保存，但${created.cacheWarning.message}`)
      }
    } catch (error) { if (!controller.signal.aborted) { setMessageTone('error'); setMessage(error instanceof Error ? error.message : action === 'directory' ? '打开目录失败' : action === 'details' ? '打开详情失败' : '加入书架失败') } }
    finally { saveController.current = null; if (!controller.signal.aborted) setSaving(null) }
  }

  async function resolveListBook(): Promise<ApiBook> {
    if (!listCandidate) throw new Error('请选择搜索结果')
    const index = candidates.findIndex((candidate) => candidateSelectionKey(candidate) === listCandidate.identity)
    const result = candidates[index]
    if (!result || searchId !== listCandidate.searchId) throw new Error('搜索结果已变化，请重新选择')
    const existing = books.find((book) => sameBookIdentity(book.name, book.author, result.candidate.name, result.candidate.author))
    if (existing) return existing
    const created = await apiFetch<{ book: ApiBook }>('/api/books', { method: 'POST', body: JSON.stringify({ searchId, candidateIndex: index, candidateIdentity: { sourceId: result.sourceId, sourceFingerprint: result.sourceFingerprint, bookUrl: result.candidate.bookUrl }, addToBookshelf: false, activateEdition: false }) })
    setBooks((previous) => [...previous.filter((book) => book.id !== created.book.id), created.book])
    return created.book
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setMessage(''); setExpandedKey(undefined); setSelectedByGroup({})
    void search(keyword, precision)
  }

  async function setDomainDefault(sourceId: string) {
    const source = managedSourceById.get(sourceId)
    if (source === undefined || switchingSourceId !== null) return
    const controller = new AbortController()
    sourceSwitchRef.current?.abort()
    sourceSwitchRef.current = controller
    setSwitchingSourceId(sourceId)
    setMessageTone('info'); setMessage('正在结束当前搜索并切换书源…')
    try {
      await cancelAndWait()
      if (controller.signal.aborted) return
      await apiFetch<{ affected: number }>('/api/source-management/actions', { method: 'POST', signal: controller.signal, body: JSON.stringify({ action: 'enable', items: [{ sourceId, expectedSourceRevision: source.sourceRevision }] }) })
      const refreshed = await apiFetch<SourceManagementPage>('/api/source-management?all=true', { signal: controller.signal })
      if (controller.signal.aborted) return
      setManagedSources(refreshed.sources)
      const domain = sourceDomainInfo(sourceId).domain
      const query = keyword.trim()
      if (query.length === 0) {
        setMessageTone('success'); setMessage(`${source.name} 已设为 ${domain} 的账号默认版本。输入关键词后会使用此版本。`)
        return
      }
      setMessageTone('info'); setMessage(`${source.name} 已设为 ${domain} 的账号默认版本，正在重新搜索…`)
      const sourceIds = selectOneSourcePerDomain(refreshed.sources.filter((item) => item.enabled), compareSourceManagementOrder).map((item) => item.sourceId)
      const searched = await replaceSearch(query, precision, sourceIds.length <= 32 ? sourceIds : undefined)
      if (!controller.signal.aborted) {
        setMessageTone(searched ? 'success' : 'error')
        setMessage(searched ? `${source.name} 已设为 ${domain} 的账号默认版本，搜索结果已更新。` : `${source.name} 已设为账号默认版本，但重新搜索未完成。`)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessageTone('error')
        setMessage(error instanceof Error ? error.message : '切换默认书源失败')
      }
    } finally {
      if (sourceSwitchRef.current === controller) sourceSwitchRef.current = null
      if (!controller.signal.aborted) setSwitchingSourceId(null)
    }
  }

  return <section className="page-stack page-narrow search-page">
    {cancellationPending ? <div className="notice-with-recovery"><DismissibleMessage className="error" role="alert">搜索取消尚未完成。</DismissibleMessage><Button variant="secondary" size="sm" onClick={() => void cancel()}>重试取消</Button></div> : null}
    <PageHeader backTo={targetBookId.length > 0 ? `/books/${encodeURIComponent(targetBookId)}/sources` : "/discover"} title="搜索书籍" description={status === 'loading' ? '结果正在陆续到达…' : '输入书名或作者'} actions={<Link className="button small page-action" to="/sources">管理书源</Link>} />
    <form className="search-panel" onSubmit={(event) => void submitSearch(event)}>
      <div className="search-row"><label className="sr-only" htmlFor={`${page?.id ?? 'search'}-keyword`}>关键词</label><Input className="search-input" id={`${page?.id ?? 'search'}-keyword`} value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名、作者或分类" autoComplete="off" /><PrecisionToggle checked={precision} disabled={status === 'loading'} onChange={setPrecision} /><Button className={status === 'loading' ? 'cancel-button-active' : 'cancel-button'} variant={status === 'loading' ? 'secondary' : 'default'} type={status === 'loading' ? 'button' : 'submit'} disabled={saving !== null || (status !== 'loading' && keyword.trim().length === 0)} onClick={status === 'loading' ? () => void cancel() : undefined}>{status === 'loading' ? '取消' : '搜索'}</Button></div>

    </form>
    {searchMessage.length > 0 ? <DismissibleMessage className="muted compact-message" role="status">{searchMessage}</DismissibleMessage> : null}
    {sourceManagementError.length > 0 ? <DismissibleMessage className="muted compact-message" role="status">同域版本列表暂不可用：{sourceManagementError}。可在书源管理页切换版本。</DismissibleMessage> : null}
    {message.length > 0 ? <DismissibleMessage onDismiss={() => setMessage('')} className={`${messageTone === 'error' ? 'error' : messageTone === 'success' ? 'success' : 'muted'} compact-message`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</DismissibleMessage> : null}
    {status === 'loading' ? <LoadingState message={'正在搜索书籍…' + (progress === undefined ? '' : ` 书源 ${progress.completed}/${progress.total}${progress.currentGroup ? " · " + progress.currentGroup : ""}`)} variant={groups.length === 0 ? 'content' : 'inline'} /> : null}
    {groups.length === 0 && status === 'done' && !booksLoaded ? <LoadingState message="正在读取已有书籍…" variant="viewport" /> : null}
    <div className="result-summary" aria-live="polite">{status === 'done' && booksLoaded ? `找到 ${groups.length} 本书` : groups.length > 0 ? `${groups.length} 本书` : ''}</div>
    {status === 'paused' ? <div className="actions"><Button onClick={() => void resume()}>继续搜索</Button><Button variant="secondary" onClick={() => void cancel()}>停止搜索</Button></div> : null}
    <div className="result-list">{groups.length === 0 && status === 'done' && booksLoaded ? <div className="empty-state">没有找到匹配书籍。</div> : groups.slice(0, visibleCount).map((group) => <SearchResult key={group.key} group={group} inBookshelf={shelfBooks.some((book) => sameBookIdentity(book.name, book.author, group.name, group.author))} selectedIndex={selectedCandidateIndex(group.items, selectedByGroup[group.key])} expanded={expandedKey === group.key} disabled={!booksLoaded || saving !== null || switchingSourceId !== null} sourceGroupsByKey={managedGroupByKey} sourceById={managedSourceById} switchingSourceId={switchingSourceId} onSetDefault={(sourceId) => void setDomainDefault(sourceId)} onToggle={() => setExpandedKey((current) => current === group.key ? undefined : group.key)} saving={saving !== null && group.items.some((item) => item.index === saving)} onSelect={(index) => { const item = candidates[index]; if (item !== undefined) setSelectedByGroup((current) => ({ ...current, [group.key]: candidateSelectionKey(item) })) }} onSave={(action) => void saveCandidate(group, action)} />)}</div>
    {groups.length > visibleCount ? <Button variant="secondary" onClick={() => setVisibleCount((value) => value + 50)}>继续显示结果</Button> : null}
    {listCandidate ? <BookListPicker book={books.find((book) => sameBookIdentity(book.name, book.author, listCandidate.group.name, listCandidate.group.author)) ?? { name: listCandidate.group.name, author: listCandidate.group.author }} resolveBook={resolveListBook} {...(targetBookListId ? { defaultListId: targetBookListId } : {})} onClose={() => setListCandidate(null)} onSaved={() => { setMessageTone('success'); setMessage('已加入书单') }} /> : null}
  </section>
}

function SearchResult({ group, inBookshelf, selectedIndex, expanded, disabled, saving, sourceGroupsByKey, sourceById, switchingSourceId, onSetDefault, onToggle, onSelect, onSave }: { group: CandidateGroup; inBookshelf: boolean; selectedIndex: number | undefined; expanded: boolean; disabled: boolean; saving: boolean; sourceGroupsByKey: Map<string, SourceDomainGroup<ManagedSourceSummary>>; sourceById: Map<string, ManagedSourceSummary>; switchingSourceId: string | null; onSetDefault: (sourceId: string) => void; onToggle: () => void; onSelect: (index: number) => void; onSave: (action: 'shelf' | 'directory' | 'details' | 'list') => void }) {
  const [sourceVisibleCount, setSourceVisibleCount] = useState(50)
  const selected = group.items.find((item) => item.index === selectedIndex) ?? group.items[0]
  if (selected === undefined) return null
  const intro = selected.item.candidate.intro?.trim() ?? ''
  const rank = searchMatchRank(group.name, selected.item.candidate.name, selected.item.candidate.author, selected.item.candidate.kind)
  const selectedDomain = sourceDomainInfo(selected.item.sourceId)
  const selectedDomainGroup = sourceGroupsByKey.get(selectedDomain.key)
  const enabledVersions = selectedDomainGroup?.versions.filter(({ source }) => source.enabled) ?? []
  const effectiveSource = [...enabledVersions].sort((left, right) => compareSourceManagementOrder(left.source, right.source))[0]?.source
  const selectedDisplayName = selectedDomainGroup?.versions.find(({ source }) => source.sourceId === selected.item.sourceId)?.displayName ?? sourceById.get(selected.item.sourceId)?.name ?? selected.item.sourceId
  const candidateDomains = new Map<string, { domain: string; items: CandidateGroup['items'] }>()
  const visibleItems = group.items.slice(0, sourceVisibleCount)
  if (!visibleItems.includes(selected)) visibleItems.push(selected)
  for (const entry of visibleItems) {
    const info = sourceDomainInfo(entry.item.sourceId)
    const domain = candidateDomains.get(info.key) ?? { domain: info.domain, items: [] }
    domain.items.push(entry)
    candidateDomains.set(info.key, domain)
  }

  return <article className="result-card" onClick={(event) => {
    // 操作按钮和来源选择保持独立，卡片其余区域复用详情打开流程。
    if (disabled || saving || !(event.target instanceof Element) || event.target.closest('button,a,input,select,label')) return
    onSave('details')
  }}>
    <button type="button" className="result-detail-cover" aria-label={"查看详情：" + group.name} disabled={disabled || saving} onClick={() => onSave('details')}><BookCover name={group.name} coverUrl={selected.item.candidate.coverUrl} size="result" /></button>
    <div className="result-card-body">
      <div className="result-card-heading">
        <div><h2><button type="button" className="result-detail-title" disabled={disabled || saving} onClick={() => onSave('details')}>{group.name}</button></h2><p className="muted small">{group.author} · {group.items.length} 个来源</p></div>
        <div className="result-card-actions"><Button className="save-button" size="sm" type="button" disabled={disabled || saving || inBookshelf} onClick={() => onSave('shelf')}>{inBookshelf ? '已在书架' : saving ? '处理中' : '加入书架'}</Button><Button className="save-button" variant="secondary" size="sm" type="button" disabled={disabled || saving} onClick={() => onSave('list')}>加入书单</Button><Button className="save-button" variant="secondary" size="sm" type="button" disabled={disabled || saving} onClick={() => onSave('directory')}>目录</Button></div>
      </div>
      {group.items.length > 1 ? <label className="result-source-select"><span className="muted small">选择本次结果来源</span><Select value={String(selected.index)} disabled={disabled || saving} onChange={(event) => onSelect(Number(event.target.value))}>{[...candidateDomains.entries()].map(([domainKey, domain]) => <optgroup key={domainKey} label={domain.domain}>{domain.items.map(({ item, index }) => { const displayName = sourceGroupsByKey.get(domainKey)?.versions.find(({ source }) => source.sourceId === item.sourceId)?.displayName ?? sourceById.get(item.sourceId)?.name ?? item.sourceId; return <option key={`${item.sourceId}:${item.candidate.bookUrl}`} value={index}>{displayName} · {item.sourceId}</option> })}</optgroup>)}</Select></label> : <p className="muted small result-source-label">來源：{selectedDisplayName} · {selectedDomain.domain}</p>}
      {group.items.length > sourceVisibleCount ? <Button size="sm" variant="secondary" onClick={() => setSourceVisibleCount((value) => value + 50)}>继续显示来源</Button> : null}
      {selectedDomainGroup !== undefined && selectedDomainGroup.versions.length > 1 ? <label className="result-source-select"><span className="muted small">{selectedDomain.domain} · 账号默认版本（切换后重新搜索）</span><Select value={effectiveSource?.sourceId ?? ''} disabled={disabled || switchingSourceId !== null} onChange={(event) => onSetDefault(event.target.value)}>{effectiveSource === undefined ? <option value="" disabled>未设置默认版本</option> : null}{selectedDomainGroup.versions.map(({ source, displayName }) => <option key={source.sourceId} value={source.sourceId}>{displayName} · {formatSourceRuleDateTime(source.lastUpdateTime)}</option>)}</Select></label> : null}
      <p className="muted small result-source-meta">规则更新时间：{formatSourceRuleDateTime(sourceById.get(selected.item.sourceId)?.lastUpdateTime)} · 匹配：{rank === 'exact' ? '完全匹配' : rank === 'kind' ? '分类命中' : rank === 'contains' ? '包含关键词' : '其他'}{selected.item.candidate.updateTime ? ` · 书目更新：${selected.item.candidate.updateTime}` : ''}{selected.item.searchDurationMs === undefined ? '' : ` · 耗时：${selected.item.searchDurationMs}ms`}</p>
      {intro.length > 0 ? <div className={`result-intro ${expanded ? 'expanded' : ''}`}><button type="button" className="result-detail-intro" disabled={disabled || saving} onClick={() => onSave('details')}>{intro}</button>{intro.length > 90 ? <button className="text-button" type="button" onClick={onToggle}>{expanded ? '收起简介' : '展开简介'}</button> : null}</div> : null}
    </div>
  </article>
}

function groupCandidates(candidates: ApiCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>()
  const seen = new Set<string>()
  candidates.forEach((item, index) => {
    const name = item.candidate.name?.trim() || `未命名书籍 · ${item.sourceId}`
    const author = item.candidate.author?.trim() || '作者未知'
    const key = item.candidate.name?.trim().length && author !== '作者未知' ? `${normalizeIdentity(name)}\u0000${normalizeIdentity(author)}` : `${item.sourceId}\u0000${item.candidate.bookUrl}`
    const group = groups.get(key) ?? { key, name, author, items: [] }
    const identity = candidateSelectionKey(item)
    if (!seen.has(identity)) { group.items.push({ item, index }); seen.add(identity) }
    groups.set(key, group)
  })
  return [...groups.values()]
}
