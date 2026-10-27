import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { MemoryReaderRepository, PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb, getReaderDb } from '../../server/db/client.ts'
import { chapterIdFor, createReaderRuntime } from '../../server/runtime/reader-runtime.ts'
import { listDiscoverySources } from '../../server/runtime/discovery.ts'
import type { Chapter } from '@legado/source-core'

const url = process.env.READER_WEB_TEST_DATABASE_URL
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

test('摘要投影与单章目录在真实数据库中保持隔离、版本和顺序并减少返回量', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  assert.ok(url)
  const admin = postgres(url, { max: 1, onnotice: () => undefined })
  const role = `egress_${randomUUID().replaceAll('-', '')}`
  const userId = randomUUID(), otherUser = randomUUID(), bookId = randomUUID()
  t.after(async () => {
    await closeReaderDb()
    await admin`delete from reader.user_sources where user_id in (${userId}, ${otherUser})`
    await admin`delete from reader.toc_snapshots where user_id = ${userId}`
    await admin`delete from reader.book_source_candidates where user_id = ${userId}`
    await admin`delete from reader.book_editions where user_id = ${userId}`
    await admin`delete from reader.books where user_id = ${userId}`
    await admin`drop owned by ${admin(role)}`
    await admin`drop role ${admin(role)}`
    await admin.end()
  })
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select, insert, update, delete on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(url); appUrl.username = role
  process.env.DATABASE_URL = appUrl.toString()
  const repo = new PostgresReaderRepository()
  const client = (getReaderDb() as ReturnType<typeof getReaderDb> & { $client: ReturnType<typeof postgres> }).$client
  const originalRowTransform = client.options.transform.row.from
  let receivedBytes = 0, receivedRows = 0, observing = false
  // 在驱动解析结果后、Drizzle 和仓储映射前计量，避免丢弃大字段后产生虚假的减量结果。
  client.options.transform.row.from = (row) => {
    if (observing) { receivedBytes += bytes(row); receivedRows++ }
    return originalRowTransform ? originalRowTransform(row) : row
  }
  t.after(() => { client.options.transform.row.from = originalRowTransform })
  const observe = async <T>(operation: () => Promise<T>) => {
    receivedBytes = 0; receivedRows = 0; observing = true
    const started = performance.now()
    try {
      const value = await operation()
      assert.ok(receivedRows > 0, '计量必须包含数据库实际返回的行')
      return { value, receivedBytes, receivedRows, elapsedMs: performance.now() - started }
    } finally { observing = false }
  }
  const rules = { ruleContent: { content: '大规则'.repeat(4096) } }
  const definitions = Array.from({ length: 1000 }, (_, i) => ({
    user_id: userId, source_id: `https://source-${i}.example`, fingerprint: `fp-${i}`, revision: `rev-${i}`, enabled: i !== 4, deleted: i === 3, custom_order: i,
    raw_source: { ...rules, marker: 'raw' }, normalized_source: { ...rules, bookSourceUrl: `https://source-${i}.example`, bookSourceName: `书源${i}`, bookSourceGroup: '小说', author: ' 作者 ', customOrder: i, lastUpdateTime: 10, enabledExplore: i !== 2, exploreUrl: i === 1 ? '   ' : 'https://example/explore' },
  }))
  for (let i = 0; i < definitions.length; i += 100) await admin`insert into reader.user_sources ${admin(definitions.slice(i, i + 100).map((row) => ({ ...row, raw_source: JSON.stringify(row.raw_source), normalized_source: JSON.stringify(row.normalized_source) })))}`
  await admin`insert into reader.user_sources (user_id, source_id, fingerprint, revision, raw_source, normalized_source) values (${otherUser}, 'other-source', 'fp', 'rev', '{}', '{"bookSourceName":"其他用户"}')`
  const params = { page: 1, pageSize: 20, query: '', status: 'all' as const }
  const managedRead = await observe(() => repo.listManagedSources(userId, { ...params, all: true }))
  const all = managedRead.value
  assert.equal(all.total, 999)
  assert.equal(all.enabledCount, 998)
  assert.equal(all.sources[0]?.author, '作者')
  assert.equal(all.sources[0]?.lastUpdateTime, 10)
  assert.equal((await repo.listManagedSources(userId, { ...params, status: 'disabled' })).sources[0]?.sourceId, definitions[4]!.source_id)
  const page = await repo.listManagedSources(userId, { ...params, page: 2 })
  assert.deepEqual(page.sources, all.sources.slice(20, 40))
  assert.ok((await repo.listManagedSources(userId, { ...params, query: '书源12' })).sources.every((row) => row.name.includes('书源12')))
  assert.equal((await repo.listSourceSummaries(otherUser)).length, 1)
  assert.deepEqual(await repo.listSourceSummaries(userId, []), [])
  const summaryRead = await observe(() => repo.listSourceSummaries(userId))
  const summaries = summaryRead.value
  assert.equal(summaries.length, 998)
  assert.ok(summaries.every((row) => !('rawSource' in row) && !('normalizedSource' in row)))
  assert.equal((await listDiscoverySources(repo, userId)).sources.length, 996)
  const relatedRead = await observe(() => repo.listSourceSummaries(userId, definitions.slice(0, 5).map((row) => row.source_id)))
  const related = relatedRead.value
  assert.equal(related.length, 4)
  assert.equal(related.find((row) => row.sourceId === definitions[4]!.source_id)?.enabled, false)
  await admin`update reader.user_sources set normalized_source = jsonb_set(normalized_source, '{bookSourceName}', '"已更新"'), revision = 'new-rev' where user_id = ${userId} and source_id = ${definitions[0]!.source_id}`
  assert.equal((await repo.listSourceSummaries(userId, [definitions[0]!.source_id]))[0]?.name, '已更新')
  // 同域旧数据仍按管理顺序选唯一有效版本，不能先按发现能力过滤再选。
  await admin`insert into reader.user_sources (user_id,source_id,fingerprint,revision,raw_source,normalized_source,custom_order) values (${userId}, ${definitions[1]!.source_id + '/alternate'}, 'fp', 'rev', '{}', '{"bookSourceName":"同域后选","customOrder":1001,"exploreUrl":"url"}', 1001)`
  assert.equal((await listDiscoverySources(repo, userId)).sources.some((row) => row.sourceId.endsWith('/alternate')), false)
  const oldRows = await admin`select * from reader.user_sources where user_id = ${userId} and not deleted`
  const baseline = bytes(oldRows)
  assert.ok(managedRead.receivedBytes < baseline * 0.2, '管理列表数据库返回量应减少至少 80%')
  assert.ok(summaryRead.receivedBytes < baseline * 0.2, '启用摘要数据库返回量应减少至少 80%')
  assert.ok(relatedRead.receivedBytes < baseline * 0.2, '相关来源数据库返回量应减少至少 80%')
  t.diagnostic(`1000 书源结果字节代理值：完整记录 ${baseline}，驱动管理摘要 ${managedRead.receivedBytes}，驱动启用摘要 ${summaryRead.receivedBytes}，驱动5来源摘要 ${relatedRead.receivedBytes}`)

  const chapters: Chapter[] = Array.from({ length: 10000 }, (_, index) => ({ sourceId: 'https://example', bookUrl: 'https://example/book', index, chapterUrl: `https://example/章节/${Math.floor(index / 2)}?q=中文📚`, title: `第${index}章`, isVip: false, rawFields: {}, traceRef: 'fixture' }))
  await repo.saveToc(userId, { userId, bookId, editionKey: 'edition', sourceFingerprint: 'fp', revision: 'r1', chapters, bookPatch: { lastCheckTime: 0, totalChapterNum: chapters.length } })
  const memory = new MemoryReaderRepository()
  await memory.saveToc(userId, { userId, bookId, editionKey: 'edition', sourceFingerprint: 'fp', revision: 'r1', chapters, bookPatch: { lastCheckTime: 0, totalChapterNum: chapters.length } })
  for (const index of [0, 1, 9999]) {
    const id = chapterIdFor(chapters[index]!)
    assert.deepEqual(await repo.getChapterContext(userId, bookId, 'edition', id), await memory.getChapterContext(userId, bookId, 'edition', id))
  }
  assert.equal(await repo.getChapterContext(otherUser, bookId, 'edition', chapterIdFor(chapters[0]!)), null)
  assert.equal(await repo.getChapterContext(userId, randomUUID(), 'edition', chapterIdFor(chapters[0]!)), null)
  assert.deepEqual(await repo.getChapterContext(userId, bookId, 'edition', 'invalid'), { revision: 'r1', sourceFingerprint: 'fp' })
  const measure = async (operation: () => Promise<unknown>) => {
    let elapsedMs = 0, totalBytes = 0
    for (let i = 0; i < 10; i++) {
      const reading = await observe(operation)
      elapsedMs += reading.elapsedMs; totalBytes += reading.receivedBytes
    }
    return { averageMs: elapsedMs / 10, receivedBytes: totalBytes / 10 }
  }
  const targetId = chapterIdFor(chapters[9999]!)
  const full = await measure(async () => {
    const toc = await repo.getToc(userId, bookId, 'edition')
    assert.equal(toc?.chapters.findIndex((chapter) => chapterIdFor(chapter) === targetId), 9999)
    return toc
  })
  const context = await measure(() => repo.getChapterContext(userId, bookId, 'edition', targetId))
  assert.ok(context.receivedBytes < full.receivedBytes * 0.01, '单章查询的数据库返回量应小于完整目录的 1%')
  t.diagnostic(`10000 章目录：完整 ${JSON.stringify(full)}；末章上下文 ${JSON.stringify(context)}`)
  await repo.saveToc(userId, { userId, bookId, editionKey: 'edition', sourceFingerprint: 'fp2', revision: 'r2', chapters: [], bookPatch: { lastCheckTime: 0, totalChapterNum: 0 } })
  assert.deepEqual(await repo.getChapterContext(userId, bookId, 'edition', chapterIdFor(chapters[0]!)), { revision: 'r2', sourceFingerprint: 'fp2' })

  const candidate = { sourceId: definitions[0]!.source_id, sourceFingerprint: 'fp-0', candidate: { sourceId: definitions[0]!.source_id, bookUrl: 'book', name: '书', rawFields: {}, traceRef: 'test' } }
  const metadata = { ...candidate.candidate, emptyFields: [], fieldErrors: {} }
  const created = await repo.createBook(userId, { candidate, metadata, editionKey: 'book-edition', sourceFingerprint: 'fp-0' })
  await repo.saveBookSourceCandidates(userId, created.book.id, [candidate, { ...candidate, sourceFingerprint: 'stale' }])
  t.mock.method(repo, 'listAllSourcesForUser', async () => { throw new Error('不应全量读取书源') })
  t.mock.method(repo, 'listSourceStatesForUser', async () => { throw new Error('不应全量读取规则状态') })
  const result = await createReaderRuntime(repo).listBookSources(userId, created.book.id)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0]?.name, '已更新')
})
