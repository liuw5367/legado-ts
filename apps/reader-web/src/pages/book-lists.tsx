import { EmptyState } from '../components/empty-state.tsx'
import { Library } from 'lucide-react'
import { DismissibleMessage } from '../components/dismissible-message.tsx'
import { Compass, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { PageHeader } from '../components/page-header.tsx'
import { BookListCover } from '../components/book-list-cover.tsx'
import { BookListEditor } from '../components/book-list-editor.tsx'
import { MoreMenu } from '../components/more-menu.tsx'
import { Button } from '../components/ui/button.tsx'
import { Sheet } from '../components/ui/sheet.tsx'
import { apiFetch, type ApiBookList } from '../lib/api.ts'
import { usePageLoadEffect } from '../lib/use-page-resource.ts'
import { pageReturnState } from '../lib/page-navigation.ts'
import { formatShanghaiDateTime } from '../lib/time-format.ts'

export function BookListsPage() {
  const location = useLocation(); const [lists, setLists] = useState<ApiBookList[] | null>(null); const [editor, setEditor] = useState<ApiBookList | 'new' | null>(null); const [deleting, setDeleting] = useState<ApiBookList | null>(null); const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0)
  usePageLoadEffect((settle) => { const controller = new AbortController(); void apiFetch<{ lists: ApiBookList[] }>('/api/book-lists', { signal: controller.signal }).then((result) => setLists(result.lists)).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败') }).finally(settle); return () => controller.abort() }, [retry], ['booklists', 'booklist-books'])
  async function remove() { if (!deleting) return; setSaving(true); try { await apiFetch(`/api/book-lists/${deleting.id}`, { method: 'DELETE' }); setDeleting(null) } catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败') } finally { setSaving(false) } }
  return <section className="page-stack page-narrow"><PageHeader title="书单" description={lists ? `共 ${lists.length} 个书单` : '正在读取…'} actions={<><Link className="button small secondary page-action" to="/discover" state={pageReturnState(location)}><Compass aria-hidden="true" /><span>发现</span></Link><Button className="page-action" size="sm" onClick={() => setEditor('new')}><Plus aria-hidden="true" /><span>新增</span></Button></>} />{error ? <DismissibleMessage onDismiss={() => setError('')} className="error" role="alert">{error}<Button onClick={() => { setError(''); setRetry((value) => value + 1) }}>重试</Button></DismissibleMessage> : null}{lists?.length === 0 ? <EmptyState icon={Library} title="还没有书单" description="点击右上角新增书单" /> : null}<div className="book-list">{lists?.map((list) => <article className="book-row" key={list.id}><Link className="book-row-main" to={`/book-lists/${list.id}`} state={pageReturnState(location)}><BookListCover books={list.coverBooks} /><span className="book-row-info"><strong>{list.name}</strong><span className="muted book-list-description">{list.description}</span><span className="muted small">{list.bookCount} 本 · {formatShanghaiDateTime(list.updatedAt)}</span></span></Link><MoreMenu label={`更多操作：${list.name}`}><button className="more-menu-item" onClick={() => setEditor(list)}>编辑书单</button><button className="more-menu-item danger-action" onClick={() => setDeleting(list)}>删除书单</button></MoreMenu></article>)}</div>{editor ? <BookListEditor {...(editor === 'new' ? {} : { list: editor })} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setRetry((value) => value + 1) }} /> : null}{deleting ? <Sheet open title={`删除书单“${deleting.name}”？`} onOpenChange={(open) => { if (!open) setDeleting(null) }}><p>仅删除书单及其评价，书籍、书架和阅读记录会保留。</p>{error ? <DismissibleMessage onDismiss={() => setError('')} className="error" role="alert">{error}</DismissibleMessage> : null}<div className="actions"><Button variant="secondary" onClick={() => setDeleting(null)}>取消</Button><Button disabled={saving} onClick={() => void remove()}>删除书单</Button></div></Sheet> : null}</section>
}
