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
  assert.match(await response.text(), /<title>Legado Reader<\/title>/u)
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
  for (const method of ['getBook', 'listEditions', 'listBookSourceCandidates', 'listSourceStatesForUser', 'listAllSourcesForUser', 'setCustomCover'] as const) t.mock.method(PostgresReaderRepository.prototype, method, memory[method].bind(memory))
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
