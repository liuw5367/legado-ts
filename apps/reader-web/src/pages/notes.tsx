import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MoreMenu } from '../components/more-menu.tsx'
import { PageHeader } from '../components/page-header.tsx'
import { ReadingMarksList } from '../components/reading-marks-list.tsx'
import { apiFetch } from '../lib/api.ts'
import { usePageLoadEffect, usePageNavigation, usePageVersion } from '../lib/use-page-resource.ts'
import { DismissibleMessage } from '../components/dismissible-message.tsx'

type BookChoice = { id: string; name: string; author: string | null; activeEditionKey?: string }
type ApiBooks = { books: Array<{ book: { id: string; name: string; author?: string }; edition: { editionKey: string } }> }
const cachedBooks = new Map<string, BookChoice[]>()
export function NotesPage() {
  const [params, setParams] = useSearchParams(); const q = params.get('q') ?? ''; const bookId = params.get('bookId') ?? ''; const deleted = params.get('deleted') === 'true'
  const navigation = usePageNavigation(); const notesVersion = usePageVersion(['notes']); const booksKey = `${navigation?.userId ?? ''}:${notesVersion}`
  const [input, setInput] = useState(q); const [books, setBooks] = useState<BookChoice[]>([]); const [error, setError] = useState(''); const [retry, setRetry] = useState(0)
  useEffect(() => setInput(q), [q])
  usePageLoadEffect((settle) => {
    const cached = cachedBooks.get(booksKey)
    if (cached) { setBooks(cached); settle(); return }
    const controller = new AbortController()
    void Promise.all([apiFetch<{ books: BookChoice[] }>('/api/annotations/books', { signal: controller.signal }), apiFetch<ApiBooks>('/api/books', { signal: controller.signal })]).then(([marked, library]) => {
      const byBook = new Map(library.books.map(({ book, edition }) => [book.id, edition.editionKey]))
      const result = marked.books.map((book) => { const activeEditionKey = byBook.get(book.id); return { ...book, ...(activeEditionKey ? { activeEditionKey } : {}) } })
      cachedBooks.set(booksKey, result); setBooks(result); setError('')
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取书籍失败') }).finally(() => { if (!controller.signal.aborted) settle() })
    return () => controller.abort()
  }, [retry, booksKey], ['notes'])
  function filterBook(value: string) { const next = new URLSearchParams(params); value ? next.set('bookId', value) : next.delete('bookId'); setParams(next, { replace: true }) }
  function submitSearch(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const next = new URLSearchParams(params); input.trim() ? next.set('q', input.trim()) : next.delete('q'); setParams(next, { replace: true }) }
  function showDeleted(value: boolean) { const next = new URLSearchParams(params); value ? next.set('deleted', 'true') : next.delete('deleted'); setParams(next, { replace: true }) }
  const activeEditions = Object.fromEntries(books.filter((book) => book.activeEditionKey).map((book) => [book.id, book.activeEditionKey!]))
  return <section className="page-stack page-narrow notes-page"><PageHeader title={deleted ? "笔记管理 · 已删除内容" : "笔记管理"} backTo="/account/settings" actions={<MoreMenu label="更多笔记管理操作">{deleted ? <button className="more-menu-item" type="button" onClick={() => showDeleted(false)}>笔记内容</button> : <button className="more-menu-item" type="button" onClick={() => showDeleted(true)}>删除内容</button>}</MoreMenu>} />
    <form className="notes-filter" role="search" onSubmit={submitSearch}><input className="input" type="search" enterKeyHint="search" aria-label="搜索摘录或想法" placeholder="搜索摘录或想法" value={input} maxLength={200} onChange={(event) => setInput(event.target.value)} /><select className="select" aria-label="筛选书籍" value={bookId} onChange={(event) => filterBook(event.target.value)}><option value="">全部书籍</option>{books.map((book) => <option key={book.id} value={book.id}>{book.name}{books.some((b) => b.id !== book.id && b.name === book.name) && book.author ? ' · ' + book.author : ''}</option>)}</select></form>
    {error ? <DismissibleMessage className="error" role="alert" onDismiss={() => setError('')}>{error}<button className="text-button" type="button" onClick={() => setRetry((n) => n + 1)}>重试</button></DismissibleMessage> : null}
    <ReadingMarksList kind="annotations" global activeEditions={activeEditions} {...(bookId ? { bookId } : {})} q={q} deleted={deleted} />
  </section>
}
