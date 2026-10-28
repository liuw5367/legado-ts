import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { tocSummary, PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb } from '../../server/db/client.ts'
import type { StoredCandidate } from '../../server/domain/types.ts'

const testUrl = process.env.READER_WEB_TEST_DATABASE_URL

test('real migrations, cache persistence, RLS and authenticated source API', { skip: testUrl === undefined ? '需要独立READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  // 此测试只连接显式提供的独立数据库，不读取项目生产配置。
  assert.ok(testUrl)
  const admin = postgres(testUrl, { max: 1, onnotice: () => undefined })
  const role = `reader_verify_${randomUUID().replaceAll('-', '')}`
  let restricted: ReturnType<typeof postgres> | undefined
  t.after(async () => { await closeReaderDb(); await restricted?.end(); await admin`drop owned by ${admin(role)}`; await admin`drop role ${admin(role)}`; await admin.end() })
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select, insert, update, delete on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(testUrl); appUrl.username = role
  process.env.DATABASE_URL = appUrl.toString()
  restricted = postgres(appUrl.toString(), { max: 1 })
  const repository = new PostgresReaderRepository()
  const userA = '00000000-0000-0000-0000-000000000001'
  const userB = '00000000-0000-0000-0000-000000000002'
  const candidate: StoredCandidate = { sourceId: 'https://8.8.8.8/source', sourceFingerprint: 'fp', candidate: { sourceId: 'https://8.8.8.8/source', bookUrl: 'https://8.8.8.8/book', name: '测试书', author: '作者', rawFields: { cacheToken: 'runtime-marker' }, traceRef: 'fixture', variable: '{"token":"runtime-marker"}', infoPage: { body: '详情正文不应缓存', requestUrl: 'url', responseUrl: 'url' } } }
  const metadata = { ...candidate.candidate, emptyFields: [], fieldErrors: {} }
  const created = await repository.createBook(userA, { candidate, metadata, editionKey: 'edition-a', sourceFingerprint: 'fp' })
  const readingInfo = await repository.getBookReadingInfo(userA, created.book.id)
  assert.deepEqual(readingInfo, { book: { id: created.book.id, name: '测试书', author: '作者', activeEditionKey: 'edition-a' }, edition: { editionKey: 'edition-a', name: '测试书' } })
  assert.equal(await repository.getBookReadingInfo(userB, created.book.id), null)
  assert.equal(await repository.getBookReadingInfo(userA, created.book.id, 'missing'), null)
  const displayChapter = { sourceId: candidate.sourceId, bookUrl: metadata.bookUrl, chapterUrl: 'https://8.8.8.8/chapter-中文', index: 0, title: '第一章', isVip: false, isVolume: true, rawFields: { ignored: '内部数据' }, traceRef: 'internal' }
  const savedToc = await repository.saveToc(userA, { userId: userA, bookId: created.book.id, editionKey: 'edition-a', sourceFingerprint: 'fp', revision: 'r1', chapters: [displayChapter], bookPatch: { lastCheckTime: 1, totalChapterNum: 1 }, bookAfter: metadata, truncated: true })
  const displayId = tocSummary(savedToc).chapters[0]!.chapterId
  await repository.saveContent(userA, { userId: userA, bookId: created.book.id, editionKey: 'edition-a', tocRevision: 'r1', sourceFingerprint: 'fp', chapterId: displayId, content: { chapter: displayChapter, contentType: 'text', raw: '原始正文', cleaned: '展示正文', pages: ['展示正文'], resources: [], truncated: true } })
  const display = await repository.getContentDisplay(userA, 'edition-a', 'r1', displayId)
  assert.equal(display?.content.cleaned, '展示正文')
  assert.equal(display?.content.chapter.chapterId, displayId)
  assert.equal(display?.truncated, true)
  assert.equal('raw' in display!.content, false)
  assert.equal('pages' in display!.content, false)
  assert.equal(await repository.getContentDisplay(userB, 'edition-a', 'r1', displayId), null)
  assert.deepEqual(await repository.activateEdition(userA, created.book.id, 'edition-a'), { editionKey: 'edition-a' })
  assert.equal(await repository.activateEdition(userB, created.book.id, 'edition-a'), null)
  assert.deepEqual(await repository.getTocSummary(userA, created.book.id, 'edition-a'), tocSummary(savedToc))
  assert.equal(await repository.getTocSummary(userB, created.book.id, 'edition-a'), null)
  await repository.saveBookSourceCandidates(userA, created.book.id, [candidate, candidate])
  await repository.saveBookSourceCandidates(userA, created.book.id, [candidate])
  const cached = await repository.listBookSourceCandidates(userA, created.book.id)
  assert.equal(cached.length, 1)
  assert.equal(cached[0]?.candidate.candidate.infoPage, undefined)
  assert.equal(cached[0]?.candidate.candidate.variable, '{"token":"runtime-marker"}')
  assert.deepEqual(cached[0]?.candidate.candidate.rawFields, { cacheToken: 'runtime-marker' })
  assert.equal((await repository.listBookSourceCandidates(userB, created.book.id)).length, 0)
  await assert.rejects(repository.saveBookSourceCandidates(userB, created.book.id, [candidate]), /不存在/u)
  // 不依赖Repository的where条件验证RLS。
  const client = restricted
  await assert.rejects(client.begin(async (sql) => {
    await sql`select set_config('app.user_id', ${userB}, true)`
    assert.equal((await sql`select * from reader.book_source_candidates`).length, 0)
    await sql`insert into reader.book_source_candidates (user_id, book_id, source_id, source_fingerprint, book_url, candidate) values (${userA}, ${created.book.id}, 'attack', 'fp', 'url', '{}')`
  }), /row-level security/u)
  await repository.saveEdition(userA, created.book.id, { candidate, metadata: { ...metadata, name: '不得覆盖书籍名', bookUrl: 'https://8.8.8.8/other' }, editionKey: 'edition-b', sourceFingerprint: 'fp' })
  assert.equal((await repository.getBook(userA, created.book.id))?.name, '测试书')
  assert.equal((await repository.getBook(userA, created.book.id))?.activeEditionKey, 'edition-a')
  assert.equal((await repository.listEditions(userA, created.book.id)).length, 2)
  process.env.SUPABASE_URL = 'https://8.8.8.8/auth-fixture'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture-public-key'
  process.env.READER_WEB_ENV_FILE = '/private/tmp/nonexistent-reader-test-env'
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({ id: new Headers(init?.headers).get('Authorization') === 'Bearer other-user-token' ? userB : userA, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }))
  const { default: app } = await import('../../server/app.ts')
  assert.equal((await app.request(`/api/books/${created.book.id}/sources`)).status, 401)
  const response = await app.request(`/api/books/${created.book.id}/sources`, { headers: { Authorization: 'Bearer fixture-token' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).activeEditionKey, 'edition-a')
  assert.equal((await app.request(`/api/books/${created.book.id}/sources`, { headers: { Authorization: 'Bearer other-user-token' } })).status, 404)
  const missing = await app.request(`/api/books/${created.book.id}/sources/00000000-0000-0000-0000-000000000099/open`, { method: 'POST', headers: { Authorization: 'Bearer fixture-token' } })
  assert.equal(missing.status, 404)
})
