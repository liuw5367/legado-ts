import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../components/page-header.tsx'
import { ReadingMarksList } from '../components/reading-marks-list.tsx'
import { apiFetch } from '../lib/api.ts'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { DismissibleMessage } from '../components/dismissible-message.tsx'

type BookChoice = { id: string; name: string; author: string | null }
export function NotesPage() {
  const [params, setParams] = useSearchParams(); const q = params.get('q') ?? ''; const bookId = params.get('bookId') ?? ''; const deleted = params.get('deleted') === 'true'
  const [input, setInput] = useState(q); const [books, setBooks] = useState<BookChoice[]>([]); const [error, setError] = useState(''); const [retry, setRetry] = useState(0)
  useEffect(() => setInput(q), [q])
  useEffect(() => {
    if (input === q) return
    const timer = window.setTimeout(() => { const next = new URLSearchParams(params); input.trim() ? next.set('q', input.trim()) : next.delete('q'); setParams(next, { replace: true }) }, input.trim() ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [input, q, params, setParams])
  usePageLoadEffect((settle) => { const controller = new AbortController(); void apiFetch<{ books: BookChoice[] }>('/api/annotations/books', { signal: controller.signal }).then((r) => { setBooks(r.books); setError('') }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取书籍失败') }).finally(() => { if (!controller.signal.aborted) settle() }); return () => controller.abort() }, [retry], ['notes'])
  function filter(key: string, value: string) { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); if (input.trim()) next.set('q', input.trim()); setParams(next, { replace: true }) }
  return <section className="page-stack page-narrow notes-page"><PageHeader title="笔记" backTo="/account/settings" />
    <div className="notes-filter"><input type="search" aria-label="搜索摘录或想法" placeholder="搜索摘录或想法" value={input} maxLength={200} onChange={(event) => setInput(event.target.value)} /><select aria-label="筛选书籍" value={bookId} onChange={(event) => filter('bookId', event.target.value)}><option value="">全部书籍</option>{books.map((book) => <option key={book.id} value={book.id}>{book.name}{books.some((b) => b.id !== book.id && b.name === book.name) && book.author ? ' · ' + book.author : ''}</option>)}</select></div>
    <div className="notes-status-tabs" role="tablist" aria-label="笔记状态"><button type="button" role="tab" aria-selected={!deleted} onClick={() => filter('deleted', '')}>笔记</button><button type="button" role="tab" aria-selected={deleted} onClick={() => filter('deleted', 'true')}>已删除</button></div>
    {error ? <DismissibleMessage className="error" role="alert" onDismiss={() => setError('')}>{error}<button className="text-button" type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></DismissibleMessage> : null}
    <ReadingMarksList kind="annotations" global {...(bookId ? { bookId } : {})} q={q} deleted={deleted} />
  </section>
}
