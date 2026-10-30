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
  const domainRead = await observe(() => repo.listManagedSources(userId, { ...params, all: true, domain: 'https://SOURCE-0.example:443/other' }))
  assert.deepEqual(domainRead.value.sources, all.sources.filter((source) => source.sourceId === definitions[0]!.source_id))
  assert.equal(domainRead.value.enabledCount, all.enabledCount)
  assert.ok(domainRead.receivedBytes < managedRead.receivedBytes * 0.5, '单域查询不应传回其他域名的完整摘要与导入信息')
  assert.deepEqual((await repo.listManagedSources(userId, { ...params, all: true, domain: 'https://missing.example' })).sources, [])
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
  t.diagnostic(`1000 书源结果字节代理值：完整记录 ${baseline}，驱动管理摘要 ${managedRead.receivedBytes}，驱动单域摘要（含身份查询）${domainRead.receivedBytes}，驱动启用摘要 ${summaryRead.receivedBytes}，驱动5来源摘要 ${relatedRead.receivedBytes}`)

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

test('页面展示查询在驱动层排除原文、规则、执行变量和无关版本', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  assert.ok(url)
  const admin = postgres(url, { max: 1, onnotice: () => undefined })
  const role = `display_${randomUUID().replaceAll('-', '')}`, user = randomUUID(), other = randomUUID(), bookId = randomUUID(), listId = randomUUID()
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select, insert, update, delete on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(url); appUrl.username = role; process.env.DATABASE_URL = appUrl.toString()
  const repo = new PostgresReaderRepository()
  const client = (getReaderDb() as ReturnType<typeof getReaderDb> & { $client: ReturnType<typeof postgres> }).$client
  const original = client.options.transform.row.from
  let rows: unknown[] = [], observing = false
  client.options.transform.row.from = (row) => { if (observing) rows.push(row); return original ? original(row) : row }
  t.after(async () => {
    client.options.transform.row.from = original
    await closeReaderDb()
    for (const table of ['source_import_items', 'source_import_batches', 'source_import_links', 'reading_annotations', 'reading_records', 'toc_snapshots', 'bookshelf', 'book_list_items', 'book_lists', 'book_editions', 'books', 'user_sources']) await admin`delete from reader.${admin(table)} where user_id = ${user}`
    await admin`drop owned by ${admin(role)}`; await admin`drop role ${admin(role)}`; await admin.end()
  })
  const measure = async <T>(read: () => Promise<T>) => {
    rows = []; observing = true
    try { const value = await read(); assert.ok(rows.length > 0); assert.notEqual(value, null); assert.notEqual(value, undefined); if (Array.isArray(value)) assert.ok(value.length > 0); return { value, bytes: bytes(rows), text: JSON.stringify(rows) } } finally { observing = false }
  }
  const large = '执行字段禁止进入展示结果'.repeat(10000)
  const metadata = { name: '测试书', author: '作者', intro: '展示简介', sourceId: 'https://display.test', bookUrl: '/book', traceRef: '', rawFields: { large }, emptyFields: [], fieldErrors: {} }
  await admin`insert into reader.books (id,user_id,name,author,intro,active_edition_key,custom_cover_url) values (${bookId},${user},'测试书','作者',${large},'e','https://cover.test/custom')`
  for (const key of ['e', 'old']) await admin`insert into reader.book_editions (user_id,book_id,edition_key,source_id,source_fingerprint,book_url,metadata,variable) values (${user},${bookId},${key},'https://display.test','fp','/book',${JSON.stringify(metadata)}::jsonb,${large})`
  await admin`insert into reader.user_sources (user_id,source_id,fingerprint,revision,raw_source,normalized_source) values (${user},'https://display.test','fp','r',${JSON.stringify({ large })}::jsonb,${JSON.stringify({ bookSourceName: '名称', exploreUrl: 'https://explore/' + large, ruleContent: large })}::jsonb)`
  await admin`insert into reader.bookshelf (user_id,book_id) values (${user},${bookId})`
  await admin`insert into reader.reading_records (user_id,book_id,edition_key,chapter_id,chapter_url,chapter_index,title) values (${user},${bookId},'e','c','/c',0,'第一章')`
  await admin`insert into reader.book_lists (id,user_id,type,name,description) values (${listId},${user},'booklist','100%_书单','书单简介')`
  await admin`insert into reader.book_list_items (user_id,book_list_id,book_id,description) values (${user},${listId},${bookId},'独立评价')`
  const { markInputSchema } = await import('../../shared/reading-annotations.ts')
  const input = markInputSchema.parse({ editionKey: 'e', sourceFingerprint: 'fp', chapterId: 'c', chapterUrl: '/c', chapterIndex: 0, chapterTitle: '第一章', tocRevision: 'rev', anchor: { start: { paragraphIndex: 0, offset: 0 }, end: { paragraphIndex: 0, offset: 1 }, exact: '摘', prefix: '', suffix: '', contentHash: 'hash' } })
  const cachedChapter = { paragraphs: ['摘' + '原文缓存'.repeat(450)], start: input.anchor.start, end: input.anchor.end, truncatedBefore: false, truncatedAfter: false }
  let markId = ''
  for (let i = 0; i < 50; i++) {
    const item = await repo.mutateReadingMark(user, { action: 'save', kind: 'annotations', id: randomUUID(), bookId, input: { ...input, chapterUrl: '/c/' + i }, bookName: '测试书', author: '作者', sourceName: '名称', cachedChapter })
    markId = item.id
  }
  const fullMarks = await measure(() => repo.listReadingMarks(user, { kind: 'annotations' }))
  const summaryMarks = await measure(() => repo.listReadingMarkSummaries(user, { kind: 'annotations' }))
  assert.ok(summaryMarks.bytes < fullMarks.bytes * 0.4)
  assert.equal(summaryMarks.text.includes('原文缓存'), false)
  assert.equal(summaryMarks.value.items[0]?.hasCachedChapter, true)
  assert.equal(summaryMarks.value.nextCursor, null)
  const cache = await repo.getCachedMarkChapter(user, bookId, markId)
  assert.deepEqual(cache?.cachedChapter, cachedChapter)
  assert.equal(await repo.getCachedMarkChapter(other, bookId, markId), null)
  assert.equal(await repo.getCachedMarkChapter(user, randomUUID(), markId), null)
  const baseline = await measure(() => repo.listBooks(user))
  await repo.saveBookSourceCandidates(user, bookId, [{ sourceId: 'https://display.test', sourceFingerprint: 'fp', searchDurationMs: 42, candidate: { ...metadata, coverUrl: 'https://cover.test/candidate', lastChapter: '候选最新章' } }])
  const fullSources = await measure(() => Promise.all([repo.listEditions(user, bookId), repo.listBookSourceCandidates(user, bookId)]))
  const entries = await measure(() => repo.listBookSourceEntries(user, bookId))
  assert.equal(entries.value.length, 3)
  assert.equal(entries.value[0]?.status, 'discovered')
  assert.equal(entries.value[0]?.coverUrl, 'https://cover.test/candidate')
  assert.equal(entries.value[0]?.lastChapter, '候选最新章')
  assert.equal(entries.value[0]?.searchDurationMs, 42)
  assert.equal(entries.text.includes('执行字段'), false)
  assert.ok(entries.bytes < fullSources.bytes * 0.01)
  assert.deepEqual(await repo.listBookSourceEntries(other, bookId), [])
  const home = await measure(() => repo.getHome(user))
  assert.ok(home.bytes < baseline.bytes * 0.01); assert.equal(home.text.includes('执行字段'), false)
  assert.equal(home.value.bookshelf[0]?.book.customCoverUrl, 'https://cover.test/custom')
  assert.deepEqual(home.value.bookshelf[0]?.chapters, { chapterCount: null, latestChapterTitle: null, unreadChapterCount: null })
  const shelfChapters = [
    { rawFields: {}, traceRef: 'shelf-test', sourceId: 'https://display.test', bookUrl: '/book', chapterUrl: '/c', index: 0, title: '第一章' },
    { rawFields: {}, traceRef: 'shelf-test', sourceId: 'https://display.test', bookUrl: '/book', chapterUrl: '/volume', index: 1, title: '第二卷', isVolume: true },
    { rawFields: {}, traceRef: 'shelf-test', sourceId: 'https://display.test', bookUrl: '/book', chapterUrl: '/c2', index: 2, title: '第二章' },
  ]
  await repo.saveToc(user, { userId: user, bookId, editionKey: 'e', sourceFingerprint: 'fp', revision: 'shelf-r1', bookPatch: { lastCheckTime: 0, totalChapterNum: 2 }, chapters: shelfChapters })
  assert.deepEqual((await repo.getHome(user)).bookshelf[0]?.chapters, { chapterCount: 2, latestChapterTitle: '第二章', unreadChapterCount: 1 })
  await repo.saveToc(user, { userId: user, bookId, editionKey: 'e', sourceFingerprint: 'fp', revision: 'shelf-r2', bookPatch: { lastCheckTime: 0, totalChapterNum: 3 }, chapters: [...shelfChapters, { rawFields: {}, traceRef: 'shelf-test', sourceId: 'https://display.test', bookUrl: '/book', chapterUrl: '/c3', index: 3, title: '第三章' }] })
  assert.deepEqual((await repo.getHome(user)).bookshelf[0]?.chapters, { chapterCount: 3, latestChapterTitle: '第三章', unreadChapterCount: 2 })
  assert.deepEqual((await repo.getHome(other)).bookshelf, [])
  const largeChapters: Chapter[] = Array.from({ length: 10000 }, (_, index) => ({ rawFields: {}, traceRef: 'large-shelf', sourceId: 'https://display.test', bookUrl: '/book', chapterUrl: index === 0 ? '/c' : `/large/${index}`, index, title: index === 0 ? '第一章' : `第${index + 1}章` }))
  await repo.saveToc(user, { userId: user, bookId, editionKey: 'e', sourceFingerprint: 'fp', revision: 'large-shelf', chapters: largeChapters, bookPatch: { lastCheckTime: 0, totalChapterNum: 10000 } })
  const queries: string[] = []
  const originalDebug = client.options.debug
  let shelfQuery: { text: string; parameters: string[] } | undefined
  client.options.debug = (_connection, query, parameters) => { queries.push(query); if (query.includes('from \"reader\".\"bookshelf\"')) shelfQuery = { text: query, parameters: parameters.map(String) } }
  let shelfOnly
  try { shelfOnly = await measure(() => repo.getBookshelf(user)) } finally { client.options.debug = originalDebug }
  assert.equal(shelfOnly.value[0]?.chapters?.chapterCount, 10000)
  assert.ok(shelfOnly.bytes < 1500)
  assert.ok(queries.some((query) => query.includes('bookshelf')))
  assert.ok(queries.every((query) => !query.includes('toc_snapshots') && !query.includes('jsonb_array_elements')))
  assert.ok(shelfQuery)
  const newPlan = await admin.unsafe('explain (analyze, buffers, format json) ' + shelfQuery.text, shelfQuery.parameters)
  const oldPlan = await admin`explain (analyze, buffers, format json) select count(*), (array_agg(item->>'title' order by ordinality desc))[1], count(*) filter (where (item->>'index')::integer > 0) from reader.toc_snapshots t cross join lateral jsonb_array_elements(t.chapters) with ordinality as entries(item, ordinality) where t.user_id=${user} and t.book_id=${bookId} and item->>'isVolume' is distinct from 'true'`
  const newDetails = newPlan[0]!['QUERY PLAN'][0]
  const oldDetails = oldPlan[0]!['QUERY PLAN'][0]
  assert.ok(!JSON.stringify(newDetails).includes('toc_snapshots'))
  assert.ok(JSON.stringify(oldDetails).includes('jsonb_array_elements'))
  t.diagnostic(`10000章书架：新查询不访问目录，返回${shelfOnly.bytes}字节；EXPLAIN ANALYZE 执行时间：旧${oldDetails['Execution Time']}ms，新${newDetails['Execution Time']}ms（单次观测，不作为时延阈值）`)

  const list = await measure(() => repo.listBookListSummaries(user, '%_', bookId))
  assert.equal(list.value.length, 1); assert.equal(list.value[0]?.bookCount, 1); assert.equal(list.value[0]?.containsBook, true)
  assert.equal(list.value[0]?.coverBooks?.[0]?.customCoverUrl, 'https://cover.test/custom')
  await admin`update reader.book_lists set name = 'ÄBC%_书单' where user_id = ${user} and id = ${listId}`
  assert.equal((await repo.listBookListSummaries(user, 'äbc%_')).length, 1)
  const picker = await measure(() => repo.listBookListSummaries(user, '', bookId, true))
  assert.equal('coverBooks' in picker.value[0]!, false); assert.equal(picker.text.includes('https://cover.test/custom'), false)
  const detail = await measure(() => repo.getBookListDetails(user, listId))
  assert.equal(detail.value?.items[0]?.description, '独立评价'); assert.equal(detail.text.includes('执行字段'), false)
  assert.equal(await repo.getBookListDetails(other, listId), null)
  for (const read of [() => repo.listBookIdentities(user), () => repo.getReadingEntry(user, bookId), () => repo.listEditionOptions(user, bookId), () => repo.getDisplayEdition(user, bookId, 'old'), () => repo.getDisplayPosition(user, bookId, 'e'), () => repo.getShelfGroups(user, bookId), () => repo.getSourceDisplayName(user, 'https://display.test'), () => repo.listSourceSummaries(user)]) {
    const result = await measure<unknown>(read)
    assert.equal(result.text.includes('执行字段'), false)
    assert.ok(result.bytes < baseline.bytes * 0.01)
  }
  assert.deepEqual(await repo.listBookIdentities(other), [])
  assert.equal(await repo.getReadingEntry(other, bookId), null)
  assert.equal(await repo.getDisplayEdition(other, bookId, 'e'), null)
  assert.equal(await repo.getDisplayEdition(user, bookId, 'missing'), null)
  for (const [enabledExplore, exploreUrl, expected] of [[false, 'https://x', false], [true, '\u3000\ufeff\v', false], [null, 'https://x', true], [true, 123, false]] as const) {
    await admin`update reader.user_sources set normalized_source = ${JSON.stringify({ bookSourceName: '名称', enabledExplore, exploreUrl })}::jsonb where user_id = ${user}`
    assert.equal((await repo.listSourceSummaries(user))[0]?.canExplore, expected)
  }
  const linkId = randomUUID(), batchId = randomUUID()
  await admin`insert into reader.source_import_links (id,user_id,url_key,encrypted_url,display_url,sort_order) values (${linkId},${user},'display-link','private-not-for-list','来源地址',0)`
  await admin`insert into reader.source_import_batches (id,user_id,preview_id,link_id,selection,imported,new_count,updated_count,restored_count,skipped_count,unselected_count) values (${batchId},${user},${randomUUID()},${linkId},${JSON.stringify(Array.from({ length: 1000 }, (_, i) => 'chosen-id-' + i))}::jsonb,1000,1000,0,0,0,0)`
  const { importHistoryQuerySchema } = await import('../../shared/source-management.ts')
  const history = await measure(() => repo.listImportHistory(user, importHistoryQuerySchema.parse({})))
  assert.equal(history.value.batches[0]?.imported, 1000)
  assert.equal(history.text.includes('chosen-id-'), false)
  const historyItems = await measure(() => repo.listImportItems(user, batchId, importHistoryQuerySchema.parse({})))
  assert.equal(historyItems.text.includes('chosen-id-'), false)
  assert.ok(history.bytes < 2000); assert.ok(historyItems.bytes < 2000)
  await admin`update reader.user_sources set deleted = true where user_id = ${user}`
  assert.ok((await repo.listEditionOptions(user, bookId)).every((row) => row.sourceName === 'https://display.test'))
  t.diagnostic(JSON.stringify({ fullMarks: fullMarks.bytes, summaryMarks: summaryMarks.bytes, fullBooks: baseline.bytes, fullSources: fullSources.bytes, sourceEntries: entries.bytes, home: home.bytes, bookLists: list.bytes, picker: picker.bytes, listDetails: detail.bytes }))
})
