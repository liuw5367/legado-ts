import { registerReadingMarksApi } from './reading-marks-api.ts'
import { searchConcurrencySchema } from '../shared/search-settings.ts'
import { bookCoverRequestSchema } from '../shared/book-sources.ts'
import { OrganizationError } from './domain/book-organization.ts'
import { registerBookOrganizationApi } from './book-organization-api.ts'
import { bookshelfInitialGroupSchema } from '../shared/bookshelf-groups.ts'
import './env.ts'
import { BACKUP_CATEGORIES, BACKUP_MAX_TOTAL_BYTES, buildBackupPreview, sha256Bytes, type BackupCategory } from '@legado/reader-backup'
import { getBookDetails } from './runtime/book-details.ts'
import { createClient } from '@supabase/supabase-js'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { BackupRestoreError, PostgresReaderRepository, SourceManagementError, type ReaderRepository } from './db/repository.ts'
import { chapterIdFor, createReaderRuntime, ReaderRuntimeError, type ReaderRuntime, type SearchBatchOptions } from './runtime/reader-runtime.ts'
import { confirmImport, createImportPreview, listSourceActions, publicImportPreview } from './runtime/source-management.ts'
import { serveReaderAsset } from './static.ts'
import { BackupValidationError, countBackupSnapshot, createWebBackup, restoreWebBackup, validateWebBackup } from './backup.ts'
import { IMPORT_REQUEST_MAX_BYTES } from '../shared/source-import-limits.ts'
import { importHistoryQuerySchema, importLinkOrderSchema, undoPreviewSchema, undoImportSchema, importConfirmRequestSchema, importPreviewRequestSchema, sourceActionSchema, sourceManagementPageSchema, sourceOrderSchema } from '../shared/source-management.ts'
import { sourceDomainInfo } from '../shared/source-domain.ts'
import type { ReaderSettingsPatch } from './domain/types.ts'
import { discoveryBookSchema, discoveryControlSchema, discoveryPageSchema, discoverySourceSchema } from '../shared/discovery.ts'
import { getDiscoveryCategories, listDiscoverySources, loadDiscoveryPage, openDiscoveryBook, updateDiscoveryControl } from './runtime/discovery.ts'
import { getSourceLoginUi, submitSourceLogin } from './runtime/source-login.ts'
import { sourceLoginActionSchema, sourceLoginUiSchema } from '../shared/source-login.ts'
import { sourceCallbackSchema, sourcePayActionSchema } from '../shared/source-actions.ts'
import { runSourceCallback, runSourcePayAction } from './runtime/source-actions.ts'

interface Variables { userId: string }
export const app = new Hono<{ Variables: Variables }>()

const defaultRepository = new PostgresReaderRepository()
const defaultRuntime = createReaderRuntime(defaultRepository)
const dependencies: { repository: ReaderRepository; runtime: ReaderRuntime } = { repository: defaultRepository, runtime: defaultRuntime }

app.get('/api/health', (context) => context.json({ ok: true }))

export async function requireUser(context: Context<{ Variables: Variables }>): Promise<Response | undefined> {
  const authorization = context.req.header('Authorization')
  if (authorization === undefined || !/^Bearer\s+\S+$/iu.test(authorization)) return context.json({ error: { code: 'unauthenticated', message: '需要登录' } }, 401)
  const url = process.env.SUPABASE_URL?.trim() ?? ''
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  if (url.length === 0 || key.length === 0) return context.json({ error: { code: 'configuration', message: '认证服务尚未配置' } }, 503)
  const token = authorization.replace(/^Bearer\s+/iu, '')
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } })
  const { data, error } = await supabase.auth.getUser(token)
  if (error !== null || data.user === null) return context.json({ error: { code: 'unauthenticated', message: '登录已失效' } }, 401)
  context.set('userId', data.user.id)
  return undefined
}

registerBookOrganizationApi(app, () => dependencies.repository, requireUser)
registerReadingMarksApi(app, () => dependencies.repository, requireUser)

app.get('/api/me', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const userId = context.get('userId')
  return context.json({ user: { id: userId } })
})

app.get('/api/sources', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const sources = await dependencies.runtime.listSources(context.get('userId'))
    return context.json({ sources: sources.map((source) => ({ sourceId: source.sourceId, name: source.name, ...(source.group === undefined ? {} : { group: source.group }), fingerprint: source.fingerprint, enabled: source.enabled })) })
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/source-management', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const parsed = sourceManagementPageSchema.safeParse({ all: context.req.query('all'), page: context.req.query('page'), pageSize: context.req.query('pageSize'), query: context.req.query('query'), status: context.req.query('status') })
  if (!parsed.success) return context.json({ error: { code: 'invalid-input', message: '书源列表参数无效' } }, 400)
  try { return context.json(await dependencies.repository.listManagedSources(context.get('userId'), parsed.data)) } catch (error) { return handleError(context, error) }
})

app.get('/api/discovery/sources', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try { return context.json(await listDiscoverySources(dependencies.repository, context.get('userId'))) } catch (error) { return handleError(context, error) }
})

app.get('/api/discovery/categories', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const parsed = discoverySourceSchema.safeParse({ sourceId: context.req.query('sourceId') })
  if (!parsed.success) return context.json({ error: { code: 'invalid-input', message: '书源参数无效' } }, 400)
  try { return context.json(await getDiscoveryCategories(dependencies.repository, context.get('userId'), parsed.data.sourceId)) } catch (error) { return handleError(context, error) }
})

app.post('/api/discovery/page', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, discoveryPageSchema)
  if (body instanceof Response) return body
  try { return context.json(await loadDiscoveryPage(dependencies.repository, context.get('userId'), body, context.req.raw.signal)) } catch (error) { return handleError(context, error) }
})

app.post('/api/discovery/control', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, discoveryControlSchema)
  if (body instanceof Response) return body
  try { return context.json(await updateDiscoveryControl(dependencies.repository, context.get('userId'), body, context.req.raw.signal)) } catch (error) { return handleError(context, error) }
})

app.post('/api/discovery/books', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, discoveryBookSchema)
  if (body instanceof Response) return body
  try {
    const { book, edition } = await openDiscoveryBook(dependencies.repository, context.get('userId'), body, context.req.raw.signal)
    return context.json({ book: { id: book.id }, edition: { editionKey: edition.editionKey } }, 201)
  } catch (error) { return handleError(context, error) }
})

app.get('/api/sources/:sourceId/login/ui', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const parsed = sourceLoginUiSchema.safeParse({ sourceId: context.req.param('sourceId'), fingerprint: context.req.query('fingerprint') })
  if (!parsed.success) return context.json({ error: { code: 'invalid-input', message: '登录书源参数无效' } }, 400)
  try { return context.json(await getSourceLoginUi(dependencies.repository, context.get('userId'), parsed.data.sourceId, parsed.data.fingerprint, context.req.raw.signal)) } catch (error) { return handleError(context, error) }
})

app.post('/api/sources/:sourceId/login/action', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, sourceLoginActionSchema)
  if (body instanceof Response) return body
  if (body.sourceId !== context.req.param('sourceId')) return context.json({ error: { code: 'invalid-input', message: '登录书源标识不一致' } }, 400)
  try { return context.json(await submitSourceLogin(dependencies.repository, context.get('userId'), body, context.req.raw.signal)) } catch (error) { return handleError(context, error) }
})

app.post('/api/sources/:sourceId/pay-action', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, sourcePayActionSchema)
  if (body instanceof Response) return body
  if (body.sourceId !== context.req.param('sourceId')) return context.json({ error: { code: 'invalid-input', message: '书源标识不一致' } }, 400)
  try { return context.json(await runSourcePayAction(dependencies.repository, context.get('userId'), body, context.req.raw.signal)) } catch (error) { return handleError(context, error) }
})

app.post('/api/sources/:sourceId/callback', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, sourceCallbackSchema)
  if (body instanceof Response) return body
  if (body.sourceId !== context.req.param('sourceId')) return context.json({ error: { code: 'invalid-input', message: '书源标识不一致' } }, 400)
  try { return context.json(await runSourceCallback(dependencies.repository, context.get('userId'), body, context.req.raw.signal)) } catch (error) { return handleError(context, error) }
})

app.post('/api/source-management/actions', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, sourceActionSchema)
  if (body instanceof Response) return body
  try { return context.json(await listSourceActions(dependencies.repository, context.get('userId'), body.action, body.items)) } catch (error) { return handleError(context, error) }
})

app.post('/api/source-management/order', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, sourceOrderSchema)
  if (body instanceof Response) return body
  try { return context.json(await dependencies.repository.applySourceOrder(context.get('userId'), body.items)) } catch (error) { return handleError(context, error) }
})

app.post('/api/source-management/import-preview', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, importPreviewRequestSchema, false, IMPORT_REQUEST_MAX_BYTES)
  if (body instanceof Response) return body
  try { return context.json(publicImportPreview(await createImportPreview(dependencies.repository, context.get('userId'), body.url, context.req.raw.signal, body.jsonText)), 201) } catch (error) { return handleError(context, error) }
})

app.post('/api/source-management/import-confirm', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, importConfirmRequestSchema)
  if (body instanceof Response) return body
  try { return context.json({ previewId: body.previewId, ...(await confirmImport(dependencies.repository, context.get('userId'), body.previewId, body.candidateIds)) }) } catch (error) { return handleError(context, error) }
})

app.get('/api/source-management/import-links', async (context) => {
  const rejected = await requireUser(context); if (rejected) return rejected
  try { return context.json(await dependencies.repository.listImportLinks(context.get('userId'))) } catch (error) { return handleError(context, error) }
})
app.post('/api/source-management/import-links/order', async (context) => {
  const rejected = await requireUser(context); if (rejected) return rejected
  const body = await parseBody(context, importLinkOrderSchema); if (body instanceof Response) return body
  try { return context.json(await dependencies.repository.orderImportLinks(context.get('userId'), body.orderedIds, body.expectedRevision)) } catch (error) { return handleError(context, error) }
})
app.get('/api/source-management/import-history', async (context) => {
  const rejected = await requireUser(context); if (rejected) return rejected
  const query = importHistoryQuerySchema.safeParse(context.req.query()); if (!query.success) return context.json({ error: { code: 'invalid-input', message: '历史查询参数无效' } }, 400)
  try { return context.json(await dependencies.repository.listImportHistory(context.get('userId'), query.data)) } catch (error) { return handleError(context, error) }
})
app.get('/api/source-management/import-history/:batchId/items', async (context) => {
  const rejected = await requireUser(context); if (rejected) return rejected
  const query = importHistoryQuerySchema.safeParse(context.req.query()); const batchId = z.string().uuid().safeParse(context.req.param('batchId'))
  if (!query.success || !batchId.success) return context.json({ error: { code: 'invalid-input', message: '历史查询参数无效' } }, 400)
  try { return context.json(await dependencies.repository.listImportItems(context.get('userId'), batchId.data, query.data)) } catch (error) { return handleError(context, error) }
})
app.post('/api/source-management/import-history/:batchId/undo-preview', async (context) => {
  const rejected = await requireUser(context); if (rejected) return rejected
  const body = await parseBody(context, undoPreviewSchema); if (body instanceof Response) return body
  const batchId = z.string().uuid().safeParse(context.req.param('batchId')); if (!batchId.success) return context.json({ error: { code: 'invalid-input', message: '导入记录 ID 无效' } }, 400)
  try { return context.json(await dependencies.repository.previewImportUndo(context.get('userId'), batchId.data, body.itemIds)) } catch (error) { return handleError(context, error) }
})
app.post('/api/source-management/import-history/:batchId/undo', async (context) => {
  const rejected = await requireUser(context); if (rejected) return rejected
  const body = await parseBody(context, undoImportSchema); if (body instanceof Response) return body
  const batchId = z.string().uuid().safeParse(context.req.param('batchId')); if (!batchId.success) return context.json({ error: { code: 'invalid-input', message: '导入记录 ID 无效' } }, 400)
  try { return context.json(await dependencies.repository.undoImport(context.get('userId'), batchId.data, body)) } catch (error) { return handleError(context, error) }
})

app.get('/api/settings', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    return context.json({ settings: await dependencies.repository.getSettings(context.get('userId')) })
  } catch (error) {
    return handleError(context, error)
  }
})

app.put('/api/settings', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, settingsSchema)
  if (body instanceof Response) return body
  try {
    return context.json({ settings: await dependencies.repository.saveSettings(context.get('userId'), body as ReaderSettingsPatch) })
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/backup/export', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const bytes = await createWebBackup(dependencies.repository, context.get('userId'))
    return new Response(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="yedeng-backup.zip"', 'Cache-Control': 'no-store', 'X-Backup-Bytes': String(bytes.byteLength), 'X-Backup-Sha256': sha256Bytes(bytes) } })
  } catch (error) { return handleError(context, error) }
})

app.post('/api/backup/validate', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const archive = await validateWebBackup(dependencies.repository, context.get('userId'), await readBackupBody(context))
    const current = await dependencies.repository.getBackupSnapshot(context.get('userId'))
    return context.json({ manifest: archive.manifest, preview: buildBackupPreview(archive), currentCounts: countBackupSnapshot(current) })
  } catch (error) { return handleError(context, error) }
})

app.post('/api/backup/import', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const rawCategories = context.req.query('categories')?.split(',').map((item) => item.trim()).filter(Boolean) ?? [...BACKUP_CATEGORIES]
  const categories = [...new Set(rawCategories)]
  if (categories.length === 0 || categories.some((item) => !(BACKUP_CATEGORIES as readonly string[]).includes(item))) return context.json({ error: { code: 'invalid-input', message: '恢复分类无效' } }, 400)
  try {
    const result = await restoreWebBackup(dependencies.repository, context.get('userId'), await readBackupBody(context), categories as BackupCategory[])
    return context.json(result)
  } catch (error) { return handleError(context, error) }
})

app.post('/api/searches', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, searchInputSchema)
  if (body instanceof Response) return body
  try {
    const availableSources = await dependencies.runtime.listSources(context.get('userId'))
    const requestedIds = body.sourceIds === undefined || body.sourceIds.length === 0 ? body.sourceId === undefined ? availableSources.map((item) => item.sourceId) : [body.sourceId] : body.sourceIds
    if (new Set(requestedIds.map((sourceId) => sourceDomainInfo(sourceId).key)).size !== requestedIds.length) return context.json({ error: { code: 'invalid-input', message: '一次搜索每个域名只能使用一个书源版本' } }, 400)
    const selectedSources = availableSources.filter((item) => requestedIds.includes(item.sourceId))
    if (selectedSources.length !== requestedIds.length) return context.json({ error: { code: 'source-not-found', message: '请求包含已禁用或不可用的书源' } }, 404)
    const source = selectedSources[0]
    if (source === undefined || source === null) return context.json({ error: { code: 'source-not-found', message: '没有可用书源' } }, 404)
    const search = await dependencies.repository.createSearch(context.get('userId'), { keyword: body.keyword, sourceId: source.sourceId, sourceIds: selectedSources.map((item) => item.sourceId), sourceSnapshots: selectedSources.map((item) => ({ sourceId: item.sourceId, sourceFingerprint: item.fingerprint, ...(item.sourceRevision ? { sourceRevision: item.sourceRevision } : {}), ...(item.importLinkId ? { importLinkId: item.importLinkId } : {}), ...(item.priority === undefined ? {} : { priority: item.priority }) })), ...(body.precision === undefined ? {} : { precision: body.precision }) }, source.fingerprint)
    return context.json({ search }, 201)
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/searches/:searchId', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const search = await dependencies.repository.getSearch(context.get('userId'), context.req.param('searchId'))
    return search === null ? context.json({ error: { code: 'not-found', message: '搜索任务不存在' } }, 404) : context.json({ search })
  } catch (error) {
    return handleError(context, error)
  }
})

app.post('/api/searches/:searchId/batches', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, searchBatchSchema, true)
  if (body instanceof Response) return body
  const options: SearchBatchOptions = { ...(body.sourceIds === undefined ? {} : { sourceIds: body.sourceIds }), ...(body.nextPage === undefined ? {} : { nextPage: body.nextPage }) }
  if (context.req.header('Accept')?.includes('text/event-stream') === true) return streamSearchResponse(context, context.get('userId'), context.req.param('searchId'), options)
  try {
    const result = await dependencies.runtime.runSearchBatch(context.get('userId'), context.req.param('searchId'), options)
    return context.json(result)
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/searches/:searchId/stream', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  return streamSearchResponse(context, context.get('userId'), context.req.param('searchId'), {})
})

app.post('/api/searches/:searchId/cancel', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const search = await dependencies.runtime.cancelSearch(context.get('userId'), context.req.param('searchId'))
    return search === null ? context.json({ error: { code: 'not-found', message: '搜索任务不存在' } }, 404) : context.json({ search })
  } catch (error) {
    return handleError(context, error)
  }
})

app.post('/api/books', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, createBookSchema)
  if (body instanceof Response) return body
  try {
    const value = await dependencies.runtime.createBookFromSearch(context.get('userId'), body.searchId, body.candidateIndex, body.bookId, body.addToBookshelf, body.activateEdition, body.candidateIdentity)
    return context.json(value, 201)
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/books', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    return context.json({ books: await dependencies.repository.listBooks(context.get('userId')) })
  } catch (error) {
    return handleError(context, error)
  }
})

app.put('/api/books/:bookId/cover', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, bookCoverRequestSchema)
  if (body instanceof Response) return body
  try { return context.json({ book: await dependencies.runtime.setBookCover(context.get('userId'), context.req.param('bookId'), body.selection) }) }
  catch (error) { return handleError(context, error) }
})

app.get('/api/books/:bookId/details', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const value = await getBookDetails(dependencies.repository, context.get('userId'), context.req.param('bookId'), context.req.query('editionKey'))
    if (value === null) return context.json({ error: { code: 'not-found', message: '书籍或版本不存在' } }, 404)
    return context.json(value)
  } catch (error) { return handleError(context, error) }
})

app.get('/api/books/:bookId/editions', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const userId = context.get('userId')
    const book = await dependencies.repository.getBook(userId, context.req.param('bookId'))
    if (book === null) return context.json({ error: { code: 'not-found', message: '书籍不存在' } }, 404)
    return context.json({ editions: await dependencies.repository.listEditions(userId, book.id), activeEditionKey: book.activeEditionKey })
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/books/:bookId/sources', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try { return context.json(await dependencies.runtime.listBookSources(context.get('userId'), context.req.param('bookId'))) }
  catch (error) { return handleError(context, error) }
})

app.post('/api/books/:bookId/sources/:candidateId/open', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try { return context.json({ edition: await dependencies.runtime.openBookSource(context.get('userId'), context.req.param('bookId'), context.req.param('candidateId'), context.req.raw.signal) }) }
  catch (error) { return handleError(context, error) }
})

app.put('/api/books/:bookId/edition', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, activeEditionSchema)
  if (body instanceof Response) return body
  try {
    const edition = await dependencies.repository.setActiveEdition(context.get('userId'), context.req.param('bookId'), body.editionKey)
    return edition === null ? context.json({ error: { code: 'not-found', message: '书籍版本不存在' } }, 404) : context.json({ edition })
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/home', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    return context.json(await dependencies.repository.getHome(context.get('userId')))
  } catch (error) {
    return handleError(context, error)
  }
})

app.put('/api/books/:bookId/bookshelf', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    await dependencies.repository.addToBookshelf(context.get('userId'), context.req.param('bookId'))
    return context.json({ ok: true })
  } catch (error) {
    return handleError(context, error)
  }
})

app.delete('/api/books/:bookId/bookshelf', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    await dependencies.repository.removeFromBookshelf(context.get('userId'), context.req.param('bookId'))
    return context.json({ ok: true })
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/books/:bookId/position', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const editionKey = context.req.query('editionKey')
  if (editionKey === undefined || editionKey.length === 0) return context.json({ error: { code: 'invalid-input', message: '缺少 editionKey' } }, 400)
  try {
    return context.json({ position: await dependencies.repository.getPosition(context.get('userId'), context.req.param('bookId'), editionKey) })
  } catch (error) {
    return handleError(context, error)
  }
})

app.delete('/api/search-history/:historyId', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  try {
    const removed = await dependencies.repository.deleteSearchHistory(context.get('userId'), context.req.param('historyId'))
    return removed ? context.json({ ok: true }) : context.json({ error: { code: 'not-found', message: '搜索记录不存在' } }, 404)
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/books/:bookId/toc', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const editionKey = context.req.query('editionKey')
  if (editionKey === undefined || editionKey.length === 0) return context.json({ error: { code: 'invalid-input', message: '缺少 editionKey' } }, 400)
  try {
    const toc = await dependencies.runtime.getOrLoadToc(context.get('userId'), context.req.param('bookId'), editionKey, context.req.query('refresh') === 'true')
    return context.json({ toc: { ...toc, chapters: toc.chapters.map((chapter) => ({ ...chapter, chapterId: chapterIdFor(chapter) })) } })
  } catch (error) {
    return handleError(context, error)
  }
})

app.get('/api/books/:bookId/review/summary', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const editionKey = context.req.query('editionKey')
  const chapterId = context.req.query('chapterId')
  if (editionKey === undefined || editionKey.length === 0 || chapterId === undefined || chapterId.length === 0) return context.json({ error: { code: 'invalid-input', message: '缺少 editionKey 或 chapterId' } }, 400)
  try { return context.json({ summary: await dependencies.runtime.getReviewSummary(context.get('userId'), context.req.param('bookId'), editionKey, chapterId) }) }
  catch (error) { return handleError(context, error) }
})

app.get('/api/books/:bookId/review/detail', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const query = reviewQuery(context, false)
  if (query instanceof Response) return query
  try { return context.json({ page: await dependencies.runtime.getReviewDetail(context.get('userId'), context.req.param('bookId'), query.editionKey, query.chapterId, query.paragraphIndex, query.paragraphData, query.cursor) }) }
  catch (error) { return handleError(context, error) }
})

app.get('/api/books/:bookId/review/replies', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const query = reviewQuery(context, true)
  if (query instanceof Response) return query
  try { return context.json({ page: await dependencies.runtime.getReviewReplies(context.get('userId'), context.req.param('bookId'), query.editionKey, query.chapterId, query.paragraphIndex, query.reviewId!, query.paragraphData, query.cursor) }) }
  catch (error) { return handleError(context, error) }
})

app.get('/api/books/:bookId/chapters/:chapterId', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const editionKey = context.req.query('editionKey')
  if (editionKey === undefined || editionKey.length === 0) return context.json({ error: { code: 'invalid-input', message: '缺少 editionKey' } }, 400)
  try {
    const content = await dependencies.runtime.getOrLoadContent(context.get('userId'), context.req.param('bookId'), editionKey, context.req.param('chapterId'), context.req.query('refresh') === 'true')
    const toc = await dependencies.repository.getToc(context.get('userId'), context.req.param('bookId'), editionKey)
    const title = toc?.chapters.find((chapter) => chapterIdFor(chapter) === context.req.param('chapterId'))?.title
    return context.json({ content: { ...content, content: { ...content.content, chapter: { ...content.content.chapter, chapterId: context.req.param('chapterId'), ...(title === undefined ? {} : { title }) } } } })
  } catch (error) {
    return handleError(context, error)
  }
})

app.post('/api/books/:bookId/position', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, positionSchema)
  if (body instanceof Response) return body
  try {
    const position = await dependencies.repository.savePosition(context.get('userId'), {
      userId: context.get('userId'),
      bookId: context.req.param('bookId'),
      editionKey: body.editionKey,
      chapterId: body.chapterId,
      chapterUrl: body.chapterUrl,
      chapterIndex: body.chapterIndex,
      title: body.title,
      ...(body.tocRevision === undefined ? {} : { tocRevision: body.tocRevision }),
      paragraphIndex: body.paragraphIndex,
      offset: body.offset,
      version: body.version,
    })
    return context.json({ position })
  } catch (error) {
    return handleError(context, error)
  }
})

app.on(['GET', 'HEAD'], '*', async (context, next) => {
  const response = await serveReaderAsset(context.req.path, context.req.method)
  if (response !== undefined) return response
  await next()
})

app.notFound((context) => context.req.path.startsWith('/api/')
  ? context.json({ error: { code: 'not-found', message: 'API 路径不存在' } }, 404)
  : context.text('Not Found', 404))

export default app

const searchInputSchema = z.object({ keyword: z.string().trim().min(1).max(200), sourceId: z.string().trim().min(1).max(500).optional(), sourceIds: z.array(z.string().trim().min(1).max(500)).max(32).optional(), precision: z.boolean().optional() })
const searchBatchSchema = z.object({ sourceIds: z.array(z.string().trim().min(1).max(500)).max(32).optional(), nextPage: z.boolean().optional() }).default({})
const createBookSchema = z.object({ searchId: z.string().uuid(), candidateIndex: z.number().int().min(0).max(9999), candidateIdentity: z.object({ sourceId: z.string().min(1).max(4000), sourceFingerprint: z.string().min(1).max(128), bookUrl: z.string().min(1).max(4000) }).optional(), bookId: z.string().uuid().optional(), addToBookshelf: z.boolean().optional(), activateEdition: z.boolean().optional() })
const activeEditionSchema = z.object({ editionKey: z.string().min(1).max(128) })

type ReviewQuery = { editionKey: string; chapterId: string; paragraphIndex: number; paragraphData?: string; reviewId?: string; cursor?: { index: number; token?: string } }

function reviewQuery(context: Context<{ Variables: Variables }>, replies: boolean): ReviewQuery | Response {
  const editionKey = context.req.query('editionKey')
  const chapterId = context.req.query('chapterId')
  const rawIndex = context.req.query('paragraphIndex')
  const reviewId = context.req.query('reviewId')
  const page = context.req.query('page')
  const cursor = context.req.query('cursor')
  const paragraphIndex = rawIndex === undefined ? NaN : Number(rawIndex)
  const pageIndex = page === undefined ? 1 : Number(page)
  if (editionKey === undefined || editionKey.length === 0 || chapterId === undefined || chapterId.length === 0 || !Number.isSafeInteger(paragraphIndex) || (paragraphIndex !== -1 && paragraphIndex <= 0) || !Number.isSafeInteger(pageIndex) || pageIndex < 1 || (replies && (reviewId === undefined || reviewId.length === 0)) || (cursor !== undefined && cursor.length > 8192)) return context.json({ error: { code: 'invalid-input', message: '段评参数无效' } }, 400)
  const result: ReviewQuery = { editionKey, chapterId, paragraphIndex }
  const paragraphData = context.req.query('paragraphData')
  if (paragraphData !== undefined) result.paragraphData = paragraphData
  if (replies && reviewId !== undefined) result.reviewId = reviewId
  if (cursor !== undefined) result.cursor = { index: pageIndex, token: cursor }
  else if (pageIndex !== 1) result.cursor = { index: pageIndex }
  return result
}
const pageTapZonesSchema = z.object({ leftWidthPercent: z.number().int().min(18).max(64), centerWidthPercent: z.number().int().min(18).max(64), centerTopHeightPercent: z.number().int().min(18).max(64), centerMiddleHeightPercent: z.number().int().min(18).max(64), centerTopAction: z.enum(['previous', 'next']), centerBottomAction: z.enum(['previous', 'next']) }).refine((value) => value.leftWidthPercent + value.centerWidthPercent <= 82 && value.centerTopHeightPercent + value.centerMiddleHeightPercent <= 82, { message: '每个翻页区域至少占 18%' })
const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  readingMode: z.enum(['scroll', 'paged']).optional(),
  fontSize: z.number().int().min(15).max(28).optional(),
  lineHeight: z.number().min(1.4).max(2.6).optional(),
  marginTop: z.number().int().min(0).max(64).optional(),
  marginRight: z.number().int().min(0).max(64).optional(),
  marginBottom: z.number().int().min(0).max(64).optional(),
  marginLeft: z.number().int().min(0).max(64).optional(),
  general: z.object({ searchConcurrency: searchConcurrencySchema.optional(), bookshelfInitialGroup: bookshelfInitialGroupSchema.optional(), bookshelfSort: z.enum(['addedAt', 'lastReadAt']).optional() }).refine((value) => Object.keys(value).length > 0, { message: '至少需要一个通用设置项' }).optional(),
  pageTapZones: pageTapZonesSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, { message: '至少需要一个设置项' })
const positionSchema = z.object({ editionKey: z.string().min(1).max(128), chapterId: z.string().min(1).max(128), chapterUrl: z.string().min(1).max(4000), chapterIndex: z.number().int().min(0), title: z.string().min(1).max(500), tocRevision: z.string().max(128).optional(), paragraphIndex: z.number().int().min(0).max(1_000_000), offset: z.number().int().min(0).max(1_000_000), version: z.number().int().min(0).max(1_000_000) })

async function parseBody<T>(context: Context<{ Variables: Variables }>, schema: z.ZodType<T>, optional = false, maxBytes?: number): Promise<T | Response> {
  try {
    let input: unknown
    let request = context.req.raw
    if (maxBytes !== undefined && request.body !== null) {
      const reader = request.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          total += next.value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            return context.json({ error: { code: 'invalid-input', message: '导入请求超过大小限制，请缩小 JSON 文件后重试' } }, 413)
          }
          chunks.push(next.value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      request = new Request(request.url, { method: 'POST', body: bytes })
    }
    try { input = await request.json() } catch { if (!optional) throw new Error('invalid-json'); input = {} }
    const parsed = schema.safeParse(input)
    return parsed.success ? parsed.data : context.json({ error: { code: 'invalid-input', message: '请求参数无效', issues: parsed.error.issues } }, 400)
  } catch {
    return context.json({ error: { code: 'invalid-input', message: '请求体不是有效 JSON' } }, 400)
  }
}

async function readBackupBody(context: Context<{ Variables: Variables }>): Promise<Uint8Array> {
  const length = Number(context.req.header('Content-Length') ?? '')
  if (Number.isFinite(length) && length > BACKUP_MAX_TOTAL_BYTES) throw new BackupValidationError('备份请求超过大小限制')
  const body = context.req.raw.body
  if (body === null) throw new BackupValidationError('备份请求为空')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > BACKUP_MAX_TOTAL_BYTES) throw new BackupValidationError('备份请求超过大小限制')
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new BackupValidationError('备份请求为空')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function handleError(context: Context<{ Variables: Variables }>, error: unknown): Response {
  const response = errorResponse(error)
  return context.json(response.body, response.status)
}

function errorResponse(error: unknown): { body: { error: { code: string; message: string } }; status: 400 | 404 | 409 | 500 } {
  if (error instanceof OrganizationError) return { body: { error: { code: 'organization-error', message: error.message } }, status: error.status }
  if (error instanceof BackupValidationError) return { body: { error: { code: 'invalid-backup', message: error.message } }, status: 400 }
  if (error instanceof BackupRestoreError) return { body: { error: { code: 'invalid-backup-selection', message: error.message } }, status: 400 }
  if (error instanceof SourceManagementError) {
    const status = error.code === 'source-not-found' ? 404 : error.code === 'preview-invalid' ? 400 : 409
    return { body: { error: { code: error.code, message: error.message } }, status }
  }
  if (error instanceof ReaderRuntimeError) {
    const status = error.code === 'not-found' ? 404 : error.code === 'invalid-input' ? 400 : error.code === 'source-busy' ? 409 : 500
    return { body: { error: { code: error.code, message: error.message } }, status }
  }
  const message = error instanceof Error && error.message.length > 0 ? error.message : '服务器内部错误'
  const body = { error: { code: 'server-error', message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : message } }
  return { body, status: 500 }
}

function streamSearchResponse(context: Context<{ Variables: Variables }>, userId: string, searchId: string, options: SearchBatchOptions) {
  return streamSSE(context, async (stream) => {
    let sequence = 0
    const disconnected = new AbortController()
    stream.onAbort(() => disconnected.abort())
    const heartbeat = setInterval(() => { void stream.write(': heartbeat\n\n').catch(() => undefined) }, 10_000)
    await stream.writeSSE({ event: 'batch-start', data: JSON.stringify({ searchId, seq: sequence++ }) })
    try {
      const result = await dependencies.runtime.runSearchBatchStream(userId, searchId, async (source, search) => {
        await stream.writeSSE({ event: 'source-result', data: JSON.stringify({ searchId, seq: sequence++, source, progress: search.progress }) })
        await stream.writeSSE({ event: 'progress', data: JSON.stringify({ searchId, seq: sequence++, progress: search.progress }) })
      }, { ...options, signal: disconnected.signal, onProgress: async (progress) => {
        await stream.writeSSE({ event: 'progress', data: JSON.stringify({ searchId, seq: sequence++, progress }) })
      } })
      await stream.writeSSE({ event: 'batch-end', data: JSON.stringify({ searchId, seq: sequence++, hasPending: result.hasPending, retryAfterMs: result.retryAfterMs, search: { sourceStates: result.sourceResults.map(({ sourceId, nextCursor }) => ({ sourceId, nextCursor })), cancelled: result.search.cancelled }, progress: result.progress }) })
      await stream.writeSSE({ event: 'batch', data: JSON.stringify({ progress: result.progress, cacheWarning: result.cacheWarning }) })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ search: { id: searchId, status: result.search.status, cancelled: result.search.cancelled }, hasPending: result.hasPending }) })
    } catch (error) {
      const response = errorResponse(error)
      await stream.writeSSE({ event: 'error', data: JSON.stringify(response.body.error) })
    } finally {
      clearInterval(heartbeat)
    }
  })
}
