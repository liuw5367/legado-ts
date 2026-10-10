import { useEffect, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import type { BookDetailsResponse } from '../../shared/book-details.ts'
import { BookCover } from '../components/book-cover.tsx'
import { PageBackButton } from '../components/page-back-button.tsx'
import { Button } from '../components/ui/button.tsx'
import { apiFetch } from '../lib/api.ts'
import { useBookCache } from '../lib/book-cache-context.tsx'
import { pageReturnState, readingEntryState } from '../lib/page-navigation.ts'
import { browserUrl } from '../lib/reader-interactions.ts'
import { formatShanghaiDateTime } from '../lib/time-format.ts'

export function BookDetailsPage() {
  const { bookId = '' } = useParams()
  const [params] = useSearchParams()
  const editionKey = params.get('editionKey') ?? ''
  const location = useLocation()
  const cache = useBookCache()
  const [data, setData] = useState<BookDetailsResponse | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setData(cache.get(bookId, editionKey)?.details ?? null); setError('')
    void apiFetch<BookDetailsResponse>('/api/books/' + encodeURIComponent(bookId) + '/details?editionKey=' + encodeURIComponent(editionKey), { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setData(value) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '详情加载失败') })
    return () => controller.abort()
  }, [bookId, editionKey, retry, cache])
  async function updateShelf(add: boolean) {
    if (data === null || saving) return
    setSaving(true); setError('')
    try { await apiFetch('/api/books/' + encodeURIComponent(bookId) + '/bookshelf', { method: add ? 'PUT' : 'DELETE' }); setData({ ...data, onBookshelf: add }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : add ? '加入书架失败' : '移出书架失败') }
    finally { setSaving(false) }
  }
  const metadata = data?.edition.metadata
  const name = metadata?.name || data?.book.name || '书籍详情'
  const prefix = '/books/' + encodeURIComponent(bookId)
  const query = '?editionKey=' + encodeURIComponent(data?.edition.editionKey ?? editionKey)
  const original = browserUrl(data?.edition.bookUrl)
  return <section className="page-stack page-narrow book-details-page">
    <div className="toc-heading"><PageBackButton /><h1>书籍详情</h1></div>
    {error.length > 0 ? <p className="error" role="alert">{error}<Button size="sm" variant="secondary" onClick={() => setRetry((value) => value + 1)}>重试</Button></p> : null}
    {data === null ? error.length === 0 ? <p className="muted">正在读取详情…</p> : null : <>
      <div className="book-details-heading"><BookCover name={name} coverUrl={metadata?.coverUrl || data.book.coverUrl} size="result" /><div><h2>{name}</h2><p className="muted small">{metadata?.author || data.book.author || '作者未知'}</p>{metadata?.kind ? <p className="muted small">{metadata.kind}</p> : null}<p className="muted small">{data.sourceName}</p></div></div>
      <div className="book-details-actions"><Link className="button" to={prefix + '/read' + query} state={readingEntryState(location)}>阅读 / 继续阅读</Link><Link className="button secondary" to={prefix + '/toc' + query} state={pageReturnState(location)}>查看目录</Link><Button variant="secondary" disabled={saving} onClick={() => void updateShelf(!data.onBookshelf)}>{saving ? '保存中…' : data.onBookshelf ? '移出书架' : '加入书架'}</Button><Link className="button secondary" to={prefix + '/sources'} state={pageReturnState(location)}>切换书源</Link></div>
      <div className="detail-section"><h3>书籍信息</h3><dl className="book-details-meta"><div><dt>更新时间</dt><dd>{metadata?.updateTime || formatShanghaiDateTime(data.book.updatedAt)}</dd></div>{metadata?.wordCount ? <div><dt>字数</dt><dd>{metadata.wordCount}</dd></div> : null}{metadata?.searchDurationMs === undefined ? null : <div><dt>搜索耗时</dt><dd>{metadata.searchDurationMs}ms</dd></div>}<div><dt>阅读进度</dt><dd>{data.reading === undefined || data.reading === null ? '尚未开始阅读' : `${data.reading.title} · ${formatShanghaiDateTime(data.reading.lastReadAt)}`}</dd></div></dl></div>
      {metadata?.lastChapter ? <div className="detail-section"><h3>最新章节</h3><p>{metadata.lastChapter}</p></div> : null}
      <div className="detail-section"><h3>简介</h3><p className="book-details-intro">{metadata?.intro || data.book.intro || '暂无简介'}</p></div>
      {original === undefined ? null : <a className="link book-original-link" href={original} target="_blank" rel="noopener noreferrer">原地址</a>}
    </>}
  </section>
}
