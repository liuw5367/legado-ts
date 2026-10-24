import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { BookListPicker } from '../components/book-list-picker.tsx'
import { ShelfGroupPicker } from '../components/shelf-group-picker.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import type { BookDetailsResponse } from '../../shared/book-details.ts'
import { BookCover } from '../components/book-cover.tsx'
import { LoadingState } from '../components/loading-state.tsx'
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
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const [picker, setPicker] = useState<'join' | 'group' | null>(null)
  const [saving, setSaving] = useState(false)
  const [retry, setRetry] = useState(0)
  usePageLoadEffect((settle) => {
    const controller = new AbortController()
    setData((previous) => previous ?? cache.get(bookId, editionKey)?.details ?? null); setError('')
    void apiFetch<BookDetailsResponse>('/api/books/' + encodeURIComponent(bookId) + '/details?editionKey=' + encodeURIComponent(editionKey), { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setData(value) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '详情加载失败') })
      .finally(() => { if (!controller.signal.aborted) settle() })
    return () => controller.abort()
  }, [bookId, editionKey, retry], ['books', 'sources', `book:${bookId}`])
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
    <PageHeader backTo="/" title="书籍详情" />
    {feedback ? <DismissibleMessage onDismiss={() => setFeedback('')} className="success" role="status">{feedback}</DismissibleMessage> : null}
    {error.length > 0 ? <DismissibleMessage onDismiss={() => setError('')} className="error" role="alert">{error}<Button size="sm" variant="secondary" onClick={() => setRetry((value) => value + 1)}>重试</Button></DismissibleMessage> : null}
    {data === null ? error.length === 0 ? <LoadingState message="正在读取详情…" variant="viewport" action={<PageBackButton appearance="button" />} /> : null : <>
      <div className="book-details-heading"><BookCover name={name} coverUrl={metadata?.coverUrl || data.book.coverUrl} size="detail" /><div><h2>{name}</h2>{metadata?.author || data.book.author ? <p className="muted small">{metadata?.author || data.book.author}</p> : null}{metadata?.kind ? <p className="muted small">{metadata.kind}</p> : null}{data.sourceName ? <p className="muted small">{data.sourceName}</p> : null}</div></div>
      <div className="book-details-actions"><Button variant="secondary" disabled={saving} onClick={() => void updateShelf(!data.onBookshelf)}>{saving ? '保存中…' : data.onBookshelf ? '移出书架' : '加入书架'}</Button><Button variant="secondary" onClick={() => setPicker('join')}>加入书单</Button>{data.onBookshelf ? <Button variant="secondary" onClick={() => setPicker('group')}>修改分组</Button> : null}<Link className="button secondary" to={prefix + '/toc' + query} state={pageReturnState(location)}>查看目录</Link><Link className="button secondary" to={prefix + '/sources'} state={pageReturnState(location)}>切换书源</Link><Link className="button" to={prefix + '/read' + query} state={readingEntryState(location)}>阅读 / 继续阅读</Link></div>
      <div className="detail-section"><h3>书籍信息</h3><dl className="book-details-meta"><div><dt>更新时间</dt><dd>{metadata?.updateTime || formatShanghaiDateTime(data.book.updatedAt)}</dd></div>{metadata?.wordCount ? <div><dt>字数</dt><dd>{metadata.wordCount}</dd></div> : null}{metadata?.searchDurationMs === undefined ? null : <div><dt>搜索耗时</dt><dd>{metadata.searchDurationMs}ms</dd></div>}<div><dt>阅读进度</dt><dd>{data.reading === undefined || data.reading === null ? '尚未开始阅读' : `${data.reading.title} · ${formatShanghaiDateTime(data.reading.lastReadAt)}`}</dd></div></dl></div>
      {metadata?.lastChapter ? <div className="detail-section"><h3>最新章节</h3><p>{metadata.lastChapter}</p></div> : null}
      <div className="detail-section"><h3>简介</h3><p className="book-details-intro">{metadata?.intro || data.book.intro || '暂无简介'}</p></div>
      {original === undefined ? null : <a className="link book-original-link" href={original} target="_blank" rel="noopener noreferrer">原地址</a>}
    </>}
    {data && picker === 'join' ? <BookListPicker onSaved={() => setFeedback('已加入书单')} book={data.book} {...(params.get('targetBookListId') ? { defaultListId: params.get('targetBookListId')! } : {})} onClose={() => setPicker(null)} /> : data && picker === 'group' ? <ShelfGroupPicker onSaved={() => setFeedback('已修改分组')} book={data.book} onClose={() => setPicker(null)} /> : null}
  </section>
}
