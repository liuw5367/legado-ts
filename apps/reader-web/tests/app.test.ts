import test from 'node:test'
import assert from 'node:assert/strict'
import app from '../server/app.ts'
import { safeNext } from '../src/lib/auth.ts'

test('health endpoint is public', async () => {
  const response = await app.request('http://localhost/api/health')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test('SPA entrypoint is available when Vercel static files are not in the checkout snapshot', async () => {
  const response = await app.request('http://localhost/')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type')?.startsWith('text/html'), true)
  assert.match(await response.text(), /<title>页灯<\/title>/u)
})

test('SPA deep links fall back to the entrypoint without intercepting API 404s', async () => {
  const page = await app.request('http://localhost/account/settings')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id="root"><main class="boot-loading">/u)

  const api = await app.request('http://localhost/api/unknown')
  assert.equal(api.status, 404)
  assert.equal((await api.json()).error.code, 'not-found')
})

test('me endpoint rejects missing auth without reading user data', async () => {
  const response = await app.request('http://localhost/api/me')
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: { code: 'unauthenticated', message: '需要登录' } })
})

test('book details, source summaries, and review endpoints reject unauthenticated requests', async () => {
  for (const path of [
    '/api/books/00000000-0000-0000-0000-000000000001/details',
    '/api/books/00000000-0000-0000-0000-000000000001/review/summary?editionKey=edition&chapterId=chapter',
    '/api/books/00000000-0000-0000-0000-000000000001/review/detail?editionKey=edition&chapterId=chapter&paragraphIndex=1',
    '/api/books/00000000-0000-0000-0000-000000000001/review/replies?editionKey=edition&chapterId=chapter&paragraphIndex=1&reviewId=review',
    '/api/source-management?all=true',
  ]) {
    const response = await app.request('http://localhost' + path)
    assert.equal(response.status, 401)
  }
})

test('all discovery endpoints reject unauthenticated requests', async () => {
  for (const [method, path] of [['GET', '/api/discovery/sources'], ['GET', '/api/discovery/categories?sourceId=other-user'], ['POST', '/api/discovery/page'], ['POST', '/api/discovery/control'], ['POST', '/api/discovery/books']] as const) {
    const response = await app.request('http://localhost' + path, { method })
    assert.equal(response.status, 401)
  }
})

test('unknown api endpoint returns json 404', async () => {
  const response = await app.request('http://localhost/api/unknown')
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true)
})

test('callback navigation only accepts local paths', () => {
  assert.equal(safeNext('/reset-password'), '/reset-password')
  assert.equal(safeNext('//attacker.example'), '/')
  assert.equal(safeNext(null), '/')
})

test('封面写入必须认证，候选选择不允许任意 URL 或额外身份字段', async () => {
  const { bookCoverRequestSchema } = await import('../shared/book-sources.ts')
  const response = await app.request('http://localhost/api/books/00000000-0000-0000-0000-000000000001/cover', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: null }) })
  assert.equal(response.status, 401)
  assert.equal(bookCoverRequestSchema.safeParse({ selection: null }).success, true)
  assert.equal(bookCoverRequestSchema.safeParse({ selection: { sourceId: 'source', sourceFingerprint: 'fp', bookUrl: 'book' } }).success, true)
  assert.equal(bookCoverRequestSchema.safeParse({ selection: { coverUrl: 'https://arbitrary.test/cover' } }).success, false)
  assert.equal(bookCoverRequestSchema.safeParse({ selection: null, userId: 'other' }).success, false)
})

test('封面 API 通过真实认证与路由写入，仅修改当前账号的用户封面', async (t) => {
  const { MemoryReaderRepository, PostgresReaderRepository } = await import('../server/db/repository.ts')
  const { importBatch, sourceDefinition } = await import('./fixtures/import-history.ts')
  const memory = new MemoryReaderRepository()
  const userId = '11111111-1111-4111-8111-111111111111'
  await importBatch(memory, userId, sourceDefinition())
  const source = (await memory.listSourcesForUser(userId))[0]!
  const metadata = { sourceId: source.sourceId, bookUrl: 'https://history.example/book', name: '封面测试书', author: '作者', coverUrl: 'https://covers.test/original.jpg', rawFields: {}, traceRef: 'cover-api', emptyFields: [], fieldErrors: {} }
  const created = await memory.createBook(userId, { candidate: { sourceId: source.sourceId, sourceFingerprint: source.fingerprint, candidate: metadata }, metadata, sourceFingerprint: source.fingerprint, editionKey: 'edition-cover-api' })
  for (const method of ['getBook', 'listEditions', 'listBookSourceCandidates', 'listSourceSummaries', 'setCustomCover'] as const) t.mock.method(PostgresReaderRepository.prototype, method, memory[method].bind(memory))
  const previousUrl = process.env.SUPABASE_URL; const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY
  process.env.SUPABASE_URL = 'https://auth.example.test'; process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-key'
  t.after(() => { if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl; if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, input?: RequestInit) => new Response(JSON.stringify({ id: new Headers(input?.headers).get('authorization') === 'Bearer fixture-other' ? 'other-user' : userId }), { headers: { 'Content-Type': 'application/json' } }))
  const path = 'http://localhost/api/books/' + created.book.id + '/cover'
  const request = (selection: unknown, token = 'fixture-owner') => app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ selection }) })
  const selection = { sourceId: source.sourceId, sourceFingerprint: source.fingerprint, bookUrl: metadata.bookUrl }
  const result = await request(selection)
  assert.equal(result.status, 200)
  const { book } = await result.json()
  assert.equal(book.customCoverUrl, metadata.coverUrl)
  assert.equal(book.activeEditionKey, created.book.activeEditionKey)
  assert.equal((await request(selection, 'fixture-other')).status, 404)
  assert.equal((await request({ ...selection, sourceFingerprint: 'stale' })).status, 400)
  assert.equal((await request({ coverUrl: 'https://arbitrary.test/cover' })).status, 400)
  assert.equal((await request(null)).status, 200)
  assert.equal((await memory.getBook(userId, created.book.id))?.customCoverUrl, undefined)
})

test('截断的目录和正文在接口响应里带 runtimeWarning', async (t) => {
  const { MemoryReaderRepository, PostgresReaderRepository } = await import('../server/db/repository.ts')
  const { importBatch, sourceDefinition } = await import('./fixtures/import-history.ts')
  const { chapterIdFor } = await import('../server/runtime/reader-runtime.ts')
  const memory = new MemoryReaderRepository()
  const userId = '11111111-1111-4111-8111-111111111111'
  await importBatch(memory, userId, sourceDefinition())
  const source = (await memory.listSourcesForUser(userId))[0]!
  const metadata = { sourceId: source.sourceId, bookUrl: 'https://history.example/book', name: '截断测试书', author: '作者', rawFields: {}, traceRef: 'truncated-api', emptyFields: [], fieldErrors: {} }
  const created = await memory.createBook(userId, { candidate: { sourceId: source.sourceId, sourceFingerprint: source.fingerprint, candidate: metadata }, metadata, sourceFingerprint: source.fingerprint, editionKey: 'edition-truncated-api' })
  const chapter = { sourceId: source.sourceId, bookUrl: created.edition.bookUrl, chapterUrl: 'https://history.example/chapter-1', index: 0, title: '第一章', rawFields: {}, traceRef: '' }
  const chapterId = chapterIdFor(chapter)
  await memory.saveToc(userId, { userId, bookId: created.book.id, editionKey: created.edition.editionKey, sourceFingerprint: source.fingerprint, revision: 'r-truncated-api', chapters: [chapter], bookPatch: { lastCheckTime: Date.now(), totalChapterNum: 1 }, truncated: true })
  await memory.saveContent(userId, { userId, bookId: created.book.id, editionKey: created.edition.editionKey, chapterId, tocRevision: 'r-truncated-api', sourceFingerprint: source.fingerprint, content: { chapter: { sourceId: source.sourceId, bookUrl: created.edition.bookUrl, chapterUrl: chapter.chapterUrl, index: 0 }, contentType: 'text', raw: '截断正文', cleaned: '截断正文', pages: ['截断正文'], resources: [], truncated: true } })
  for (const method of ['getEdition', 'getSourceForUser', 'getToc', 'getChapterContext', 'getContent'] as const) t.mock.method(PostgresReaderRepository.prototype, method, memory[method].bind(memory))
  const previousUrl = process.env.SUPABASE_URL; const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY
  process.env.SUPABASE_URL = 'https://auth.example.test'; process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-key'
  t.after(() => { if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl; if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, input?: RequestInit) => new Response(JSON.stringify({ id: new Headers(input?.headers).get('authorization') === 'Bearer fixture-other' ? 'other-user' : userId }), { headers: { 'Content-Type': 'application/json' } }))
  const headers = { Authorization: 'Bearer fixture-owner' }
  const toc = await app.request('http://localhost/api/books/' + created.book.id + '/toc?editionKey=' + encodeURIComponent(created.edition.editionKey), { headers })
  assert.equal(toc.status, 200)
  assert.match(((await toc.json()) as { toc: { runtimeWarning?: string } }).toc.runtimeWarning ?? '', /截断/u)
  const content = await app.request('http://localhost/api/books/' + created.book.id + '/chapters/' + chapterId + '?editionKey=' + encodeURIComponent(created.edition.editionKey), { headers })
  assert.equal(content.status, 200)
  assert.match(((await content.json()) as { content: { runtimeWarning?: string } }).content.runtimeWarning ?? '', /截断/u)
})


test('本地 JSON 导入通过真实认证和路由校验链接、限制请求并保存来源', async (t) => {
  const { MemoryReaderRepository, PostgresReaderRepository } = await import('../server/db/repository.ts')
  const { sourceDefinition } = await import('./fixtures/import-history.ts')
  const { IMPORT_FILE_MAX_BYTES, IMPORT_REQUEST_MAX_BYTES } = await import('../shared/source-import-limits.ts')
  const memory = new MemoryReaderRepository()
  for (const method of ['listSourceStatesForUser', 'saveImportPreview', 'commitImportPreview'] as const) t.mock.method(PostgresReaderRepository.prototype, method, memory[method].bind(memory))
  const previousUrl = process.env.SUPABASE_URL; const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY
  process.env.SUPABASE_URL = 'https://auth.example.test'; process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-key'
  t.after(() => { if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl; if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey })
  const fetch = t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.ok(String(url).startsWith('https://auth.example.test/'))
    return Response.json({ id: 'local-user' })
  })
  const request = (body: unknown, path = '/api/source-management/import-preview') => app.request('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-owner' }, body: JSON.stringify(body) })
  assert.equal((await app.request('http://localhost/api/source-management/import-preview', { method: 'POST' })).status, 401)
  assert.equal((await request({ url: '', jsonText: '{}' })).status, 400)
  assert.equal((await request({ url: 'https://example.test', jsonText: '{bad' })).status, 400)
  assert.equal((await request({ url: 'https://example.test', jsonText: 'x'.repeat(IMPORT_REQUEST_MAX_BYTES) })).status, 413)
  const definition = JSON.stringify(sourceDefinition())
  const jsonText = definition + ' '.repeat(IMPORT_FILE_MAX_BYTES - Buffer.byteLength(definition))
  const response = await request({ url: 'https://example.test/local', jsonText })
  assert.equal(response.status, 201)
  const preview = await response.json()
  assert.equal(preview.writableCount, 1)
  const imported = await request({ previewId: preview.previewId, candidateIds: preview.candidates.map((item: { id: string }) => item.id) }, '/api/source-management/import-confirm')
  assert.equal(imported.status, 200)
  assert.equal((await imported.json()).imported, 1)
  assert.equal((await memory.listImportLinks('local-user')).links.length, 1)
  assert.ok(fetch.mock.calls.length > 0)
})

test('search concurrency settings persist per account, default to five and reject values outside five to ten', async (t) => {
  const { MemoryReaderRepository, PostgresReaderRepository } = await import('../server/db/repository.ts')
  const memory = new MemoryReaderRepository()
  for (const method of ['getSettings', 'saveSettings'] as const) t.mock.method(PostgresReaderRepository.prototype, method, memory[method].bind(memory))
  const previousUrl = process.env.SUPABASE_URL; const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY
  process.env.SUPABASE_URL = 'https://auth.example.test'; process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-key'
  t.after(() => { if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl; if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, input?: RequestInit) => new Response(JSON.stringify({ id: new Headers(input?.headers).get('authorization') === 'Bearer fixture-other' ? 'other-user' : 'settings-user' }), { headers: { 'Content-Type': 'application/json' } }))
  const get = (token = 'fixture-owner') => app.request('/api/settings', { headers: { Authorization: 'Bearer ' + token } })
  const update = (value: unknown) => app.request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-owner' }, body: JSON.stringify({ general: { searchConcurrency: value } }) })
  assert.equal((await (await get()).json()).settings.general.searchConcurrency, 5)
  for (const value of [5, 7, 10]) {
    const response = await update(value)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).settings.general.searchConcurrency, value)
    assert.equal((await (await get()).json()).settings.general.searchConcurrency, value)
  }
  for (const value of [4, 11, 20, 10.5, '10', null]) assert.equal((await update(value)).status, 400)
  assert.equal((await (await get()).json()).settings.general.searchConcurrency, 10)
  assert.equal((await (await get('fixture-other')).json()).settings.general.searchConcurrency, 5)
})

test('正文缓存命中后只用轻量章节上下文校正标题，不读取完整目录', async (t) => {
  const { PostgresReaderRepository } = await import('../server/db/repository.ts')
  const { chapterIdFor } = await import('../server/runtime/reader-runtime.ts')
  const sourceId = 'https://chapter.example'
  const chapter = { sourceId, bookUrl: sourceId + '/book', chapterUrl: sourceId + '/chapter', index: 0, title: '当前目录标题', rawFields: {}, traceRef: 'fixture' }
  const chapterId = chapterIdFor(chapter)
  const cached = { userId: '11111111-1111-4111-8111-111111111111', bookId: 'book', editionKey: 'edition', chapterId, tocRevision: 'rev', sourceFingerprint: 'fp', updatedAt: new Date().toISOString(), content: { chapter: { ...chapter, title: '旧缓存标题' }, cleaned: '缓存正文', raw: '缓存正文', contentType: 'text' as const, pages: ['缓存正文'], resources: [] } }
  t.mock.method(PostgresReaderRepository.prototype, 'getEdition', async () => ({ sourceId }))
  t.mock.method(PostgresReaderRepository.prototype, 'getSourceForUser', async () => ({ sourceId, fingerprint: 'fp', enabled: true }))
  const context = t.mock.method(PostgresReaderRepository.prototype, 'getChapterContext', async () => ({ revision: 'rev', sourceFingerprint: 'fp', chapter }))
  t.mock.method(PostgresReaderRepository.prototype, 'getContent', async () => cached)
  const fullToc = t.mock.method(PostgresReaderRepository.prototype, 'getToc', async () => { throw new Error('正文接口不能读取完整目录') })
  const previousUrl = process.env.SUPABASE_URL, previousKey = process.env.SUPABASE_PUBLISHABLE_KEY
  process.env.SUPABASE_URL = 'https://auth.example.test'; process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-key'
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: cached.userId }), { headers: { 'Content-Type': 'application/json' } }))
  const response = await app.request(`http://localhost/api/books/book/chapters/${chapterId}?editionKey=edition`, { headers: { Authorization: 'Bearer fixture-token' } })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.content.content.cleaned, '缓存正文')
  assert.equal(result.content.content.chapter.title, '当前目录标题')
  assert.equal(result.content.content.chapter.chapterId, chapterId)
  assert.equal(cached.content.chapter.title, '旧缓存标题')
  assert.ok(context.mock.callCount() > 0)
  assert.equal(fullToc.mock.callCount(), 0)
})
