import './env.ts'
import { createClient } from '@supabase/supabase-js'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { PostgresReaderRepository, type ReaderRepository } from './db/repository.ts'
import { chapterIdFor, createReaderRuntime, ReaderRuntimeError, type ReaderRuntime, type SearchBatchOptions } from './runtime/reader-runtime.ts'

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
    return context.json({ sources: await dependencies.runtime.listSources() })
  } catch (error) {
    return handleError(context, error)
  }
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
    return context.json({ settings: await dependencies.repository.saveSettings(context.get('userId'), body) })
  } catch (error) {
    return handleError(context, error)
  }
})

app.post('/api/searches', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const body = await parseBody(context, searchInputSchema)
  if (body instanceof Response) return body
  try {
    const availableSources = await dependencies.runtime.listSources()
    const requestedIds = body.sourceIds === undefined || body.sourceIds.length === 0 ? body.sourceId === undefined ? availableSources.map((item) => item.sourceId) : [body.sourceId] : body.sourceIds
    const selectedSources = availableSources.filter((item) => requestedIds.includes(item.sourceId))
    const source = selectedSources[0]
    if (source === undefined || source === null) return context.json({ error: { code: 'source-not-found', message: '没有可用书源' } }, 404)
    const search = await dependencies.repository.createSearch(context.get('userId'), { keyword: body.keyword, sourceId: source.sourceId, sourceIds: selectedSources.map((item) => item.sourceId), ...(body.precision === undefined ? {} : { precision: body.precision }) }, source.fingerprint)
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
    const value = await dependencies.runtime.createBookFromSearch(context.get('userId'), body.searchId, body.candidateIndex, body.bookId)
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

app.get('/api/books/:bookId/chapters/:chapterId', async (context) => {
  const rejected = await requireUser(context)
  if (rejected !== undefined) return rejected
  const editionKey = context.req.query('editionKey')
  if (editionKey === undefined || editionKey.length === 0) return context.json({ error: { code: 'invalid-input', message: '缺少 editionKey' } }, 400)
  try {
    const content = await dependencies.runtime.getOrLoadContent(context.get('userId'), context.req.param('bookId'), editionKey, context.req.param('chapterId'), context.req.query('refresh') === 'true')
    const toc = await dependencies.repository.getToc(context.get('userId'), context.req.param('bookId'), editionKey)
    const title = toc?.chapters.find((chapter) => chapterIdFor(chapter) === context.req.param('chapterId'))?.title
    return context.json({ content: { ...content, content: { ...content.content, chapter: { ...content.content.chapter, ...(title === undefined ? {} : { title }) } } } })
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

app.notFound((context) => context.req.path.startsWith('/api/')
  ? context.json({ error: { code: 'not-found', message: 'API 路径不存在' } }, 404)
  : context.text('Not Found', 404))

export default app

const searchInputSchema = z.object({ keyword: z.string().trim().min(1).max(200), sourceId: z.string().trim().min(1).max(500).optional(), sourceIds: z.array(z.string().trim().min(1).max(500)).max(32).optional(), precision: z.boolean().optional() })
const searchBatchSchema = z.object({ sourceIds: z.array(z.string().trim().min(1).max(500)).max(32).optional(), nextPage: z.boolean().optional() }).default({})
const createBookSchema = z.object({ searchId: z.string().uuid(), candidateIndex: z.number().int().min(0).max(9999), bookId: z.string().uuid().optional() })
const activeEditionSchema = z.object({ editionKey: z.string().min(1).max(128) })
const settingsSchema = z.object({ theme: z.enum(['system', 'light', 'dark']).optional(), fontSize: z.number().int().min(15).max(28).optional(), lineHeight: z.number().min(1.4).max(2.6).optional() }).refine((value) => Object.keys(value).length > 0, { message: '至少需要一个设置项' })
const positionSchema = z.object({ editionKey: z.string().min(1).max(128), chapterId: z.string().min(1).max(128), chapterUrl: z.string().min(1).max(4000), chapterIndex: z.number().int().min(0), title: z.string().min(1).max(500), tocRevision: z.string().max(128).optional(), paragraphIndex: z.number().int().min(0).max(1_000_000), offset: z.number().int().min(0).max(1_000_000), version: z.number().int().min(0).max(1_000_000) })

async function parseBody<T>(context: Context<{ Variables: Variables }>, schema: z.ZodType<T>, optional = false): Promise<T | Response> {
  try {
    let input: unknown
    try { input = await context.req.json() } catch { if (!optional) throw new Error('invalid-json'); input = {} }
    const parsed = schema.safeParse(input)
    return parsed.success ? parsed.data : context.json({ error: { code: 'invalid-input', message: '请求参数无效', issues: parsed.error.issues } }, 400)
  } catch {
    return context.json({ error: { code: 'invalid-input', message: '请求体不是有效 JSON' } }, 400)
  }
}

function handleError(context: Context<{ Variables: Variables }>, error: unknown): Response {
  const response = errorResponse(error)
  return context.json(response.body, response.status)
}

function errorResponse(error: unknown): { body: { error: { code: string; message: string } }; status: 400 | 404 | 409 | 500 } {
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
    const heartbeat = setInterval(() => { void stream.write(': heartbeat\n\n').catch(() => undefined) }, 10_000)
    await stream.writeSSE({ event: 'batch-start', data: JSON.stringify({ searchId, seq: sequence++ }) })
    try {
      const result = await dependencies.runtime.runSearchBatchStream(userId, searchId, async (source, search) => {
        await stream.writeSSE({ event: 'source-result', data: JSON.stringify({ searchId, seq: sequence++, source, search, progress: search.progress }) })
        await stream.writeSSE({ event: 'progress', data: JSON.stringify({ searchId, seq: sequence++, progress: search.progress }) })
      }, options)
      await stream.writeSSE({ event: 'batch-end', data: JSON.stringify({ searchId, seq: sequence++, search: result.search, progress: result.progress }) })
      await stream.writeSSE({ event: 'batch', data: JSON.stringify(result) })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ search: result.search }) })
    } catch (error) {
      const response = errorResponse(error)
      await stream.writeSSE({ event: 'error', data: JSON.stringify(response.body.error) })
    } finally {
      clearInterval(heartbeat)
    }
  })
}
