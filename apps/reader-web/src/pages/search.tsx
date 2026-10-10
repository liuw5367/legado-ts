import { normalizeIdentity, sameBookIdentity } from '../../shared/book-identity.ts'
import type { SourceCacheWarning } from '../../shared/book-sources.ts'
import { useBookSearch } from '../lib/use-book-search.ts'
import { pageReturnState } from '../lib/page-navigation.ts'
import { PageBackButton } from '../components/page-back-button.tsx'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { BookCover } from '../components/book-cover.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select } from '../components/ui/select.tsx'
import { apiFetch, type ApiBook, type ApiCandidate } from '../lib/api.ts'

interface CandidateGroup {
  key: string
  name: string
  author: string
  items: Array<{ item: ApiCandidate; index: number }>
}

export function SearchPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const queryKeyword = searchParams.get('q') ?? ''
  const targetBookId = searchParams.get('bookId') ?? ''
  const [books, setBooks] = useState<ApiBook[]>([])
  const [booksLoaded, setBooksLoaded] = useState(false)
  const [precision, setPrecision] = useState(false)
  const [keyword, setKeyword] = useState(queryKeyword)
  const { candidates, searchId, status, message: searchMessage, search, cancel } = useBookSearch()
  const [expandedKey, setExpandedKey] = useState<string>()
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, number>>({})
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'success' | 'error'>('info')
  const [saving, setSaving] = useState<number | null>(null)
  const saveController = useRef<AbortController | null>(null)
  useEffect(() => () => saveController.current?.abort(), [])
  const groups = useMemo(() => {
    const all = groupCandidates(candidates)
    if (targetBookId.length > 0 && !booksLoaded) return []
    const target = targetBookId.length === 0 ? undefined : books.find((book) => book.id === targetBookId)
    if (targetBookId.length > 0 && target === undefined) return []
    return target === undefined ? all : all.filter((group) => target.author?.trim().length && target.author !== '作者未知' ? sameBookIdentity(target.name, target.author, group.name, group.author) : normalizeIdentity(target.name) === normalizeIdentity(group.name))
  }, [books, booksLoaded, candidates, targetBookId])

  useEffect(() => {
    let active = true
    void apiFetch<{ books: Array<{ book: ApiBook }> }>('/api/books').then((result) => {
      if (active) { setBooks(result.books.map((item) => item.book)); setBooksLoaded(true) }
    }).catch((error: unknown) => {
      if (active) { setBooksLoaded(true); setMessageTone('error'); setMessage(error instanceof Error ? `已有书籍加载失败，仍可搜索：${error.message}` : '已有书籍加载失败，仍可搜索') }
    })
    return () => { active = false }
  }, [])
  useEffect(() => { setKeyword(queryKeyword) }, [queryKeyword])

  async function saveCandidate(group: CandidateGroup, action: 'shelf' | 'directory' | 'details') {
    if (!booksLoaded || saveController.current !== null) return
    const selectedIndex = selectedByGroup[group.key] ?? group.items[0]?.index
    if (selectedIndex === undefined || searchId.length === 0) return
    const result = candidates[selectedIndex]
    if (result === undefined) return
    const requestedBook = targetBookId.length > 0 ? books.find((book) => book.id === targetBookId) : undefined
    const existingBook = requestedBook ?? books.find((book) => sameBookIdentity(book.name, book.author, result.candidate.name, result.candidate.author))
    const controller = new AbortController(); saveController.current = controller
    setSaving(selectedIndex); setMessageTone('info'); setMessage('')
    try {
      const created = await apiFetch<{ book: ApiBook; edition: { editionKey: string }; cacheWarning?: SourceCacheWarning }>('/api/books', { method: 'POST', signal: controller.signal, body: JSON.stringify({ searchId, candidateIndex: selectedIndex, candidateIdentity: { sourceId: result.sourceId, sourceFingerprint: result.sourceFingerprint, bookUrl: result.candidate.bookUrl }, addToBookshelf: action === 'shelf', activateEdition: action === 'shelf' || existingBook === undefined, ...(existingBook === undefined ? {} : { bookId: existingBook.id }) }) })
      if (controller.signal.aborted) return
      if (action !== 'shelf') {
        navigate(`/books/${encodeURIComponent(created.book.id)}/${action === 'details' ? 'details' : 'toc'}?editionKey=${encodeURIComponent(created.edition.editionKey)}`, { state: pageReturnState(location) })
      } else {
        setBooks((current) => [...current.filter((book) => book.id !== created.book.id), created.book]); setMessageTone(created.cacheWarning === undefined ? 'success' : 'error'); setMessage(created.cacheWarning === undefined ? '已加入书架' : `书籍已保存，但${created.cacheWarning.message}`)
      }
    } catch (error) { if (!controller.signal.aborted) { setMessageTone('error'); setMessage(error instanceof Error ? error.message : action === 'directory' ? '打开目录失败' : action === 'details' ? '打开详情失败' : '加入书架失败') } }
    finally { saveController.current = null; if (!controller.signal.aborted) setSaving(null) }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setMessage(''); setExpandedKey(undefined); setSelectedByGroup({})
    void search(keyword, precision)
  }

  return <section className="page-stack page-narrow search-page">
    <div className="page-heading compact-heading">{targetBookId.length > 0 ? <PageBackButton fallback={`/books/${encodeURIComponent(targetBookId)}/sources`} /> : null}<div><h1>搜索书籍</h1><p className="muted">{status === 'loading' ? '结果正在陆续到达…' : '输入书名或作者'}</p></div><Link className="button secondary small" to="/sources">管理书源</Link></div>
    <form className="search-panel" onSubmit={(event) => void submitSearch(event)}>
      <div className="search-row"><label className="sr-only" htmlFor="search-keyword">关键词</label><Input className="search-input" id="search-keyword" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="书名、作者或分类" autoComplete="off" /><label className="check-inline"><input type="checkbox" checked={precision} disabled={status === 'loading'} onChange={(event) => setPrecision(event.target.checked)} /><span>精确</span></label><Button type={status === 'loading' ? 'button' : 'submit'} disabled={saving !== null || (status !== 'loading' && keyword.trim().length === 0)} onClick={status === 'loading' ? () => void cancel() : undefined}>{status === 'loading' ? '取消' : '搜索'}</Button></div>

    </form>
    {searchMessage.length > 0 ? <p className="muted compact-message" role="status">{searchMessage}</p> : null}
    {message.length > 0 ? <p className={`${messageTone === 'error' ? 'error' : messageTone === 'success' ? 'success' : 'muted'} compact-message`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</p> : null}
    <div className="result-summary" aria-live="polite">{status === 'loading' ? '正在搜索' : status === 'done' ? `找到 ${groups.length} 本书` : groups.length > 0 ? `${groups.length} 本书` : ''}</div>
    <div className="result-list">{groups.length === 0 && status === 'done' ? <div className="empty-state">{booksLoaded ? '没有找到匹配书籍。' : '正在读取已有书籍…'}</div> : groups.map((group) => <SearchResult key={group.key} group={group} selectedIndex={selectedByGroup[group.key] ?? group.items[0]?.index} expanded={expandedKey === group.key} disabled={!booksLoaded || saving !== null} onToggle={() => setExpandedKey((current) => current === group.key ? undefined : group.key)} saving={saving !== null && group.items.some((item) => item.index === saving)} onSelect={(index) => setSelectedByGroup((current) => ({ ...current, [group.key]: index }))} onSave={(action) => void saveCandidate(group, action)} />)}</div>
  </section>
}

function SearchResult({ group, selectedIndex, expanded, disabled, onToggle, saving, onSelect, onSave }: { group: CandidateGroup; selectedIndex: number | undefined; expanded: boolean; disabled: boolean; saving: boolean; onToggle: () => void; onSelect: (index: number) => void; onSave: (action: 'shelf' | 'directory' | 'details') => void }) {
  const selected = group.items.find((item) => item.index === selectedIndex) ?? group.items[0]
  if (selected === undefined) return null
  const intro = selected.item.candidate.intro?.trim() ?? ''
  return <article className="result-card"><button type="button" className="result-detail-cover" aria-label={"查看详情：" + group.name} disabled={disabled || saving} onClick={() => onSave('details')}><BookCover name={group.name} coverUrl={selected.item.candidate.coverUrl} size="result" /></button><div className="result-card-body"><div className="result-card-heading"><div><h2><button type="button" className="result-detail-title" disabled={disabled || saving} onClick={() => onSave('details')}>{group.name}</button></h2><p className="muted small">{group.author} · {group.items.length} 个书源</p></div><div className="result-card-actions"><Button className="save-button" size="sm" type="button" disabled={disabled || saving} onClick={() => onSave('shelf')}>{saving ? '处理中' : '添加书架'}</Button><Button className="save-button" variant="secondary" size="sm" type="button" disabled={disabled || saving} onClick={() => onSave('directory')}>目录</Button></div></div>{group.items.length > 1 ? <label className="result-source-select"><span className="muted small">选择书源</span><Select value={String(selected.index)} disabled={disabled || saving} onChange={(event) => onSelect(Number(event.target.value))}>{group.items.map(({ item, index }) => <option key={`${item.sourceId}:${item.candidate.bookUrl}`} value={index}>{item.sourceId}</option>)}</Select></label> : <p className="muted small result-source-label">书源：{selected.item.sourceId}</p>}{intro.length > 0 ? <div className={`result-intro ${expanded ? 'expanded' : ''}`}><button type="button" className="result-detail-intro" disabled={disabled || saving} onClick={() => onSave('details')}>{intro}</button>{intro.length > 90 ? <button className="text-button" type="button" onClick={onToggle}>{expanded ? '收起简介' : '展开简介'}</button> : null}</div> : null}</div></article>
}

function groupCandidates(candidates: ApiCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>()
  candidates.forEach((item, index) => {
    const name = item.candidate.name?.trim() || `未命名书籍 · ${item.sourceId}`
    const author = item.candidate.author?.trim() || '作者未知'
    const key = item.candidate.name?.trim().length && author !== '作者未知' ? `${normalizeIdentity(name)}\u0000${normalizeIdentity(author)}` : `${item.sourceId}\u0000${item.candidate.bookUrl}`
    const group = groups.get(key) ?? { key, name, author, items: [] }
    if (!group.items.some((entry) => entry.item.sourceId === item.sourceId && entry.item.candidate.bookUrl === item.candidate.bookUrl)) group.items.push({ item, index })
    groups.set(key, group)
  })
  return [...groups.values()]
}
