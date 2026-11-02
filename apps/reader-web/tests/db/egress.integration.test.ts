import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { MemoryReaderRepository, PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb, getReaderDb } from '../../server/db/client.ts'
import type { StoredCandidate } from '../../server/domain/types.ts'
import { chapterIdFor, createReaderRuntime } from '../../server/runtime/reader-runtime.ts'
import { listDiscoverySources } from '../../server/runtime/discovery.ts'
import { sourceDomainInfo } from '../../shared/source-domain.ts'
import type { ImportPreviewCandidate } from '../../shared/source-management.ts'
import type { Chapter } from '@legado/source-core'

const url = process.env.READER_WEB_TEST_DATABASE_URL
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const sqlParameterBytes = (values: unknown) => Array.isArray(values) ? values.reduce((total, value) => total + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : Buffer.byteLength(JSON.stringify(value) ?? '')), 0) : bytes(values)

test('摘要投影与单章目录在真实数据库中保持隔离、版本和顺序并减少返回量', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  assert.ok(url)
  const admin = postgres(url, { max: 1, onnotice: () => undefined })
  const role = `egress_${randomUUID().replaceAll('-', '')}`
  const userId = randomUUID(), otherUser = randomUUID(), legacyUser = randomUUID(), bookId = randomUUID()
  const previousRuntimeKey = process.env.SOURCE_RUNTIME_STATE_KEY
  t.after(async () => {
    await closeReaderDb()
    await admin`delete from reader.search_history where user_id = ${userId}`
    await admin`delete from reader.search_runs where user_id = ${userId}`
    await admin`delete from reader.reading_annotations where user_id = ${userId}`
    await admin`delete from reader.reading_bookmarks where user_id = ${userId}`
    await admin`delete from reader.book_list_items where user_id = ${userId}`
    await admin`delete from reader.book_lists where user_id = ${userId}`
    await admin`delete from reader.bookshelf where user_id = ${userId}`
    await admin`delete from reader.reader_settings where user_id = ${userId}`
    await admin`delete from reader.source_import_undo_operations where user_id = ${userId}`
    await admin`delete from reader.source_import_items where user_id = ${userId}`
    await admin`delete from reader.source_import_batches where user_id = ${userId}`
    await admin`delete from reader.source_import_previews where user_id = ${userId}`
    await admin`delete from reader.source_import_links where user_id = ${userId}`
    await admin`delete from reader.source_import_settings where user_id = ${userId}`
    await admin`delete from reader.user_sources where user_id in (${userId}, ${otherUser}, ${legacyUser})`
    await admin`delete from reader.source_runtime_state where user_id = ${userId}`
    await admin`delete from reader.toc_snapshots where user_id = ${userId}`
    await admin`delete from reader.book_source_candidates where user_id = ${userId}`
    await admin`delete from reader.book_editions where user_id = ${userId}`
    await admin`delete from reader.books where user_id = ${userId}`
    await admin`drop owned by ${admin(role)}`
    await admin`drop role ${admin(role)}`
    await admin.end()
    if (previousRuntimeKey === undefined) delete process.env.SOURCE_RUNTIME_STATE_KEY
    else process.env.SOURCE_RUNTIME_STATE_KEY = previousRuntimeKey
  })
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select, insert, update, delete on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(url); appUrl.username = role
  process.env.DATABASE_URL = appUrl.toString()
  process.env.SOURCE_RUNTIME_STATE_KEY = 'reader-egress-test-runtime-key-at-least-32-characters'
  const repo = new PostgresReaderRepository()
  const client = (getReaderDb() as ReturnType<typeof getReaderDb> & { $client: ReturnType<typeof postgres> }).$client
  const originalRowTransform = client.options.transform.row.from
  const originalDebug = client.options.debug
  let receivedBytes = 0, receivedRows = 0, sentParameterBytes = 0, observing = false
  // 在驱动解析结果后、Drizzle 和仓储映射前计量，避免丢弃大字段后产生虚假的减量结果。
  client.options.transform.row.from = (row) => {
    if (observing) { receivedBytes += bytes(row); receivedRows++ }
    return originalRowTransform ? originalRowTransform(row) : row
  }
  client.options.debug = (connection, query, parameters, paramTypes) => {
    if (observing) sentParameterBytes += sqlParameterBytes(parameters)
    if (typeof originalDebug === 'function') originalDebug(connection, query, parameters, paramTypes)
  }
  t.after(() => { client.options.transform.row.from = originalRowTransform; client.options.debug = originalDebug })
  const observe = async <T>(operation: () => Promise<T>) => {
    receivedBytes = 0; receivedRows = 0; sentParameterBytes = 0; observing = true
    const started = performance.now()
    try {
      const value = await operation()
      assert.ok(receivedRows > 0, '计量必须包含数据库实际返回的行')
      return { value, receivedBytes, receivedRows, sentParameterBytes, elapsedMs: performance.now() - started }
    } finally { observing = false }
  }
  const rules = { ruleContent: { content: '大规则'.repeat(4096) } }
  const definitions = Array.from({ length: 1000 }, (_, i) => ({
    user_id: userId, source_id: `https://source-${i}.example`, fingerprint: `fp-${i}`, revision: `rev-${i}`, enabled: i !== 4, deleted: i === 3, custom_order: i,
    raw_source: { ...rules, marker: 'raw' }, normalized_source: { ...rules, bookSourceUrl: `https://source-${i}.example`, bookSourceName: `书源${i}`, bookSourceGroup: '小说', author: ' 作者 ', customOrder: i, lastUpdateTime: 10, enabledExplore: i !== 2, exploreUrl: i === 1 ? '   ' : 'https://example/explore' },
  }))
  for (let i = 0; i < definitions.length; i += 100) await admin`insert into reader.user_sources ${admin(definitions.slice(i, i + 100).map((row) => ({ ...row, domain_key: row.source_id === definitions[1]!.source_id ? null : sourceDomainInfo(row.source_id).key, raw_source: JSON.stringify(row.raw_source), normalized_source: JSON.stringify(row.normalized_source) })))}`
  await admin`insert into reader.user_sources (user_id, source_id, fingerprint, revision, raw_source, normalized_source) values (${otherUser}, 'other-source', 'fp', 'rev', '{}', '{"bookSourceName":"其他用户"}')`
  const escapedLegacySourceId = 'not a URL, "quoted"\\\\path'
  await admin`insert into reader.user_sources (user_id, source_id, fingerprint, revision, raw_source, normalized_source) values (${legacyUser}, ${escapedLegacySourceId}, 'fp', 'rev', '{}', '{"bookSourceName":"旧格式来源"}')`
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
  const sourceStatsRead = await observe(() => repo.getSourceManagementStats(userId))
  assert.deepEqual(sourceStatsRead.value, { total: 999, domainCount: 999, enabledDomainCount: 998 })
  assert.ok(sourceStatsRead.receivedBytes < 512, '键控书源统计应只读取常量大小聚合结果和旧记录身份')
  assert.deepEqual(await repo.getSourceManagementStats(legacyUser), { total: 1, domainCount: 1, enabledDomainCount: 1 })
  t.diagnostic(`键控统计与一条旧 null 记录的回退合计返回 ${sourceStatsRead.receivedBytes} 字节`)
  await admin`update reader.user_sources set normalized_source = jsonb_set(normalized_source, '{bookSourceName}', '"已更新"'), revision = 'new-rev' where user_id = ${userId} and source_id = ${definitions[0]!.source_id}`
  assert.equal((await repo.listSourceSummaries(userId, [definitions[0]!.source_id]))[0]?.name, '已更新')
  // 同域旧数据仍按管理顺序选唯一有效版本，不能先按发现能力过滤再选。
  await admin`insert into reader.user_sources (user_id,source_id,fingerprint,revision,raw_source,normalized_source,custom_order) values (${userId}, ${definitions[1]!.source_id + '/alternate'}, 'fp', 'rev', '{}', '{"bookSourceName":"同域后选","customOrder":1001,"exploreUrl":"url"}', 1001)`
  const alternateSourceId = definitions[1]!.source_id + '/alternate'
  await admin`update reader.user_sources set domain_key = ${sourceDomainInfo(alternateSourceId).key} where user_id = ${userId} and source_id = ${alternateSourceId}`
  const mixedStatsRead = await observe(() => repo.getSourceManagementStats(userId))
  assert.deepEqual(mixedStatsRead.value, { total: 1000, domainCount: 999, enabledDomainCount: 998 })
  const mixedDomainRead = await repo.listManagedSources(userId, { ...params, all: true, domain: 'https://SOURCE-1.example:443/other' })
  assert.deepEqual(mixedDomainRead.sources.map((row) => row.sourceId).sort(), [definitions[1]!.source_id, alternateSourceId].sort())
  assert.equal(mixedDomainRead.enabledCount, 999)
  assert.equal((await listDiscoverySources(repo, userId)).sources.some((row) => row.sourceId.endsWith('/alternate')), false)
  const oldRows = await admin`select * from reader.user_sources where user_id = ${userId} and not deleted`
  const baseline = bytes(oldRows)
  assert.ok(managedRead.receivedBytes < baseline * 0.2, '管理列表数据库返回量应减少至少 80%')
  assert.ok(summaryRead.receivedBytes < baseline * 0.2, '启用摘要数据库返回量应减少至少 80%')
  assert.ok(relatedRead.receivedBytes < baseline * 0.2, '相关来源数据库返回量应减少至少 80%')
  t.diagnostic(`1000 书源结果字节代理值：完整记录 ${baseline}，驱动管理摘要 ${managedRead.receivedBytes}，驱动单域摘要（含身份查询）${domainRead.receivedBytes}，驱动启用摘要 ${summaryRead.receivedBytes}，驱动5来源摘要 ${relatedRead.receivedBytes}`)

  const targetSourceId = definitions[0]!.source_id
  const targetStatesRead = await observe(() => repo.getSourceStatesForIds(userId, [targetSourceId, definitions[1]!.source_id]))
  assert.equal(targetStatesRead.value.length, 2)
  assert.ok(targetStatesRead.receivedBytes < baseline * 0.1, '导入预览的本地状态读取只应返回候选来源规则')
  const sourcePage = await repo.listManagedSources(userId, { ...params, all: true, sourceIds: [targetSourceId] })
  const sourceSummary = sourcePage.sources[0]!
  const disabledRead = await observe(() => repo.applySourceActions(userId, 'disable', [{ sourceId: targetSourceId, expectedSourceRevision: sourceSummary.sourceRevision }]))
  assert.equal(disabledRead.value.affected, 1)
  assert.ok(disabledRead.receivedBytes < 512, '禁用一个来源不应返回其他规则')
  assert.ok(disabledRead.sentParameterBytes < 512, '禁用一个来源不应重传完整规则')
  const disabledSource = (await repo.getSourceStatesForIds(userId, [targetSourceId]))[0]!
  const orderedRead = await observe(() => repo.applySourceOrder(userId, [{ sourceId: targetSourceId, expectedSourceRevision: disabledSource.sourceRevision, customOrder: 20000 }]))
  assert.equal(orderedRead.value.affected, 1)
  assert.ok(orderedRead.receivedBytes < 512, '单个书源排序只应读取目标身份和版本')
  assert.ok(orderedRead.sentParameterBytes < 512, '单个书源排序只应写入顺序和版本字段')
  const reorderedSource = (await repo.getSourceStatesForIds(userId, [targetSourceId]))[0]!
  assert.equal(reorderedSource.source.enabled, false)
  assert.equal(reorderedSource.source.normalizedSource.customOrder, 20000)
  assert.deepEqual(reorderedSource.source.rawSource, definitions[0]!.raw_source)
  assert.equal(reorderedSource.source.normalizedSource.author, ' 作者 ')
  const enabledRead = await observe(() => repo.applySourceActions(userId, 'enable', [{ sourceId: targetSourceId, expectedSourceRevision: reorderedSource.sourceRevision }]))
  assert.equal(enabledRead.value.affected, 1)
  assert.ok(enabledRead.receivedBytes < baseline * 0.1, '启用单个来源的同域判断只应读取轻量来源身份')
  assert.ok(enabledRead.sentParameterBytes < 512, '启用单个来源不应重传完整规则')
  const siblingSourceId = definitions[1]!.source_id + '/alternate'
  const siblingStates = await repo.getSourceStatesForIds(userId, [definitions[1]!.source_id, siblingSourceId])
  const selectedSibling = siblingStates.find((row) => row.source.sourceId === siblingSourceId)!
  const siblingEnableRead = await observe(() => repo.applySourceActions(userId, 'enable', [{ sourceId: siblingSourceId, expectedSourceRevision: selectedSibling.sourceRevision }]))
  assert.equal(siblingEnableRead.value.affected, 1)
  const switchedSiblings = await repo.getSourceStatesForIds(userId, [definitions[1]!.source_id, siblingSourceId])
  assert.equal(switchedSiblings.filter((row) => row.source.enabled && !row.deleted).length, 1, '启用同域来源仍只保留一个活动版本')
  assert.equal(switchedSiblings.find((row) => row.source.sourceId === siblingSourceId)?.source.enabled, true)
  const deleteTargetId = definitions[2]!.source_id
  const deleteTarget = (await repo.getSourceStatesForIds(userId, [deleteTargetId]))[0]!
  const deleteLease = await repo.acquireSourceRuntimeLease(userId, deleteTargetId, deleteTarget.source.fingerprint, 'delete-guard-lease', 10_000)
  assert.ok(deleteLease)
  await assert.rejects(repo.applySourceActions(userId, 'delete', [{ sourceId: deleteTargetId, expectedSourceRevision: deleteTarget.sourceRevision }]), /书源正在使用/u)
  await repo.releaseSourceRuntimeLease(userId, deleteTargetId, deleteTarget.source.fingerprint, deleteLease.leaseToken)
  const deletedRead = await observe(() => repo.applySourceActions(userId, 'delete', [{ sourceId: deleteTargetId, expectedSourceRevision: deleteTarget.sourceRevision }]))
  assert.equal(deletedRead.value.affected, 1)
  assert.ok(deletedRead.receivedBytes < 512, '删除一个来源只应读取目标状态和租约字段')

  const currentTarget = (await repo.getSourceStatesForIds(userId, [targetSourceId]))[0]!
  const importCandidates: ImportPreviewCandidate[] = definitions.map((definition, index) => ({
    id: `egress-candidate-${index}`,
    sourceId: definition.source_id,
    name: `导入来源${index}`,
    group: '小说',
    fingerprint: definition.fingerprint,
    normalizedSource: index === 0 ? { ...definition.normalized_source, bookSourceName: '导入后的来源' } : definition.normalized_source,
    rawSource: definition.raw_source,
    disposition: index === 0 ? 'update' : 'new',
    ...(index === 0 ? { sourceRevision: currentTarget.sourceRevision } : {}),
    reason: '可导入',
  }))
  const previewId = randomUUID()
  await repo.saveImportPreview(userId, { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates: importCandidates, writableCount: importCandidates.length }, 'https://large-import.example/list.json')
  const confirmedImport = await observe(() => repo.commitImportPreview(userId, previewId, [importCandidates[0]!.id]))
  assert.equal(confirmedImport.value.imported, 1)
  assert.equal(confirmedImport.value.updatedCount, 1)
  const [batchCounts] = await admin`select updated_count, unselected_count from reader.source_import_batches where user_id = ${userId} and id = ${confirmedImport.value.batchId}`
  assert.equal(batchCounts?.updated_count, 1)
  assert.equal(batchCounts?.unselected_count, definitions.length - 1)
  assert.ok(confirmedImport.receivedBytes < baseline * 0.2, '确认一个候选不应回传预览里的其余完整规则')
  const undoPreview = await observe(() => repo.previewImportUndo(userId, confirmedImport.value.batchId))
  assert.equal(undoPreview.value.items.length, 1)
  assert.equal(undoPreview.value.items[0]?.canUndo, true)
  assert.ok(undoPreview.receivedBytes < baseline * 0.2, '撤销预览只应读取目标旧规则快照和轻量冲突状态')
  const undo = await observe(() => repo.undoImport(userId, confirmedImport.value.batchId, { idempotencyKey: randomUUID(), items: [{ itemId: undoPreview.value.items[0]!.itemId, expectedRevision: undoPreview.value.items[0]!.expectedRevision! }] }))
  assert.equal(undo.value.affected, 1)
  assert.equal(undo.value.undoStatus, 'all')
  assert.ok(undo.receivedBytes < baseline * 0.2, '撤销一个候选不应读取完整书源集合')
  const restoredTarget = (await repo.getSourceStatesForIds(userId, [targetSourceId]))[0]!
  assert.deepEqual(restoredTarget.source.rawSource, definitions[0]!.raw_source)
  assert.equal(restoredTarget.source.normalizedSource.customOrder, 20000)
  assert.equal(restoredTarget.source.normalizedSource.bookSourceName, '已更新')
  t.diagnostic(`1000 书源中本地目标状态返回 ${targetStatesRead.receivedBytes} 字节；单项禁用读取 ${disabledRead.receivedBytes}、写入 ${disabledRead.sentParameterBytes} 字节；排序读取 ${orderedRead.receivedBytes}、写入 ${orderedRead.sentParameterBytes} 字节；单候选确认读取 ${confirmedImport.receivedBytes}、写入 ${confirmedImport.sentParameterBytes} 字节；撤销预览读取 ${undoPreview.receivedBytes} 字节，撤销读取 ${undo.receivedBytes} 字节`)

  const searchSources = Array.from({ length: 8 }, (_, index) => `https://search-${index}.example/source`)
  const searchCandidate = (index: number, variant = 'stable'): StoredCandidate => {
    const sourceId = searchSources[index % searchSources.length]!
    return {
      sourceId,
      sourceFingerprint: `search-fingerprint-${index % searchSources.length}`,
      searchDurationMs: index + 1,
      candidate: {
        sourceId,
        bookUrl: `https://books.example/${index}`,
        name: `搜索结果${index}`,
        author: `作者${index % 5}`,
        variable: `variable-${index}-${variant}`,
        rawFields: { payload: '候选原始字段'.repeat(96), marker: `${index}-${variant}` },
        traceRef: `search-${index}`,
      },
    }
  }
  const stateFor = (candidates: StoredCandidate[], completedSources = searchSources.length) => searchSources.map((sourceId, index) => ({ sourceId, status: index < completedSources ? 'success' as const : 'pending' as const, candidates: candidates.filter((candidate) => candidate.sourceId === sourceId), diagnostics: [] }))
  const initialCandidates = Array.from({ length: 72 }, (_, index) => searchCandidate(index))
  initialCandidates.push(structuredClone(initialCandidates[7]!), structuredClone(initialCandidates[7]!))
  const search = await repo.createSearch(userId, { keyword: '搜索结果', sourceId: searchSources[0]!, sourceIds: searchSources })
  const initialStates = stateFor(initialCandidates, 5)
  const initialRun = (await repo.updateSearch(userId, search.id, { knownRun: search, sourceStates: initialStates, candidates: initialCandidates, status: 'running' }))!
  assert.deepEqual((await repo.getSearch(userId, search.id))?.candidates, initialCandidates)
  const operationId = randomUUID()
  const claimedRun = await repo.claimSearch(userId, search.id, operationId, initialStates, { completed: 5, total: searchSources.length }, initialRun.version, initialRun)
  assert.ok(claimedRun)
  const firstFlushCandidates = [...initialCandidates].reverse()
  firstFlushCandidates[0] = { ...firstFlushCandidates[0]!, candidate: { ...firstFlushCandidates[0]!.candidate, variable: 'variable-7-replaced' } }
  const sameJsonDifferentKeyOrder = initialCandidates[3]!
  const reorderedJsonCandidate = {
    candidate: Object.fromEntries(Object.entries(sameJsonDifferentKeyOrder.candidate).reverse()),
    searchDurationMs: sameJsonDifferentKeyOrder.searchDurationMs,
    sourceFingerprint: sameJsonDifferentKeyOrder.sourceFingerprint,
    sourceId: sameJsonDifferentKeyOrder.sourceId,
  } as StoredCandidate
  firstFlushCandidates[firstFlushCandidates.indexOf(sameJsonDifferentKeyOrder)] = reorderedJsonCandidate
  const sameUrlCandidate = initialCandidates[20]!
  const sameUrlDifferentVariable = {
    ...sameUrlCandidate,
    candidate: { ...sameUrlCandidate.candidate, variable: 'different-variable', rawFields: { ...sameUrlCandidate.candidate.rawFields, changed: 'different raw fields' } },
  }
  firstFlushCandidates[firstFlushCandidates.indexOf(sameUrlCandidate)] = sameUrlDifferentVariable
  firstFlushCandidates.splice(10, 1)
  firstFlushCandidates.push(searchCandidate(1000))
  const firstFlushStates = stateFor(firstFlushCandidates, 6)
  const firstFlush = await observe(() => repo.updateSearch(userId, search.id, { knownRun: claimedRun, expectedOperationId: operationId, operationId, sourceStates: firstFlushStates, candidates: firstFlushCandidates, status: 'running', progress: { completed: 6, total: searchSources.length } }))
  assert.ok(firstFlush.value)
  assert.deepEqual(firstFlush.value.candidates, firstFlushCandidates)
  assert.deepEqual(firstFlush.value.sourceStates, firstFlushStates, '逐来源检查点仍应按完整候选快照恢复')
  const initialCandidateBytes = bytes(initialCandidates)
  assert.ok(firstFlush.sentParameterBytes < initialCandidateBytes * 0.25, '多数候选不变时数据库参数应主要包含旧数组索引')
  assert.ok(firstFlush.receivedBytes < initialCandidateBytes * 0.05, '持有 knownRun 时不应从数据库回读完整候选正文')

  const secondFlushCandidates = [...firstFlushCandidates.slice(12), ...firstFlushCandidates.slice(0, 12), searchCandidate(1001)]
  const secondFlushStates = stateFor(secondFlushCandidates, 7)
  const secondFlush = await observe(() => repo.updateSearch(userId, search.id, { knownRun: firstFlush.value!, expectedOperationId: operationId, operationId, sourceStates: secondFlushStates, candidates: secondFlushCandidates, status: 'running', progress: { completed: 7, total: searchSources.length } }))
  assert.ok(secondFlush.value)
  assert.deepEqual((await repo.getSearch(userId, search.id))?.candidates, secondFlushCandidates, '第二次来源完成后的快照也必须完整可恢复')
  assert.deepEqual(secondFlush.value.sourceStates, secondFlushStates)

  const staleDelta = await repo.updateSearch(userId, search.id, { knownRun: claimedRun, expectedOperationId: operationId, candidates: [...initialCandidates, searchCandidate(1002)], status: 'running' })
  assert.equal(staleDelta, null, 'knownRun 版本过期时不能用旧索引重组或覆盖当前结果')
  assert.deepEqual((await repo.getSearch(userId, search.id))?.candidates, secondFlushCandidates)

  const fallbackCandidates = [searchCandidate(2000)]
  const fallbackFlush = await observe(() => repo.updateSearch(userId, search.id, { knownRun: secondFlush.value!, expectedOperationId: operationId, operationId: null, sourceStates: stateFor(fallbackCandidates), candidates: fallbackCandidates, status: 'success', progress: { completed: searchSources.length, total: searchSources.length } }))
  assert.ok(fallbackFlush.value)
  assert.ok(fallbackFlush.sentParameterBytes >= bytes(fallbackCandidates), '全量序列化较小时应自动回退完整写入')
  assert.deepEqual((await repo.getSearch(userId, search.id))?.candidates, fallbackCandidates)
  const emptyFlush = await repo.updateSearch(userId, search.id, { knownRun: fallbackFlush.value, candidates: [], sourceStates: stateFor([]), status: 'empty' })
  assert.deepEqual(emptyFlush?.candidates, [], '空搜索结果应明确持久化为空数组')
  t.diagnostic(`搜索候选 ${initialCandidates.length} 项，完整 JSON 参数 ${initialCandidateBytes} 字节；首次重排增量参数 ${firstFlush.sentParameterBytes} 字节/读取 ${firstFlush.receivedBytes} 字节/耗时 ${firstFlush.elapsedMs.toFixed(1)} ms；第二次增量参数 ${secondFlush.sentParameterBytes} 字节/读取 ${secondFlush.receivedBytes} 字节/耗时 ${secondFlush.elapsedMs.toFixed(1)} ms；全量回退参数 ${fallbackFlush.sentParameterBytes} 字节/耗时 ${fallbackFlush.elapsedMs.toFixed(1)} ms`)

  const chapters: Chapter[] = Array.from({ length: 10000 }, (_, index) => ({ sourceId: 'https://example', bookUrl: 'https://example/book', index, chapterUrl: `https://example/章节/${Math.floor(index / 2)}?q=中文📚`, title: `第${index}章`, isVip: false, ...(index === 100 ? { isVolume: true } : {}), rawFields: {}, traceRef: 'fixture' }))
  const savedToc = await observe(() => repo.saveToc(userId, { userId, bookId, editionKey: 'edition', sourceFingerprint: 'fp', revision: 'r1', chapters, bookPatch: { lastCheckTime: 0, totalChapterNum: chapters.length } }))
  assert.equal(savedToc.value.chapters.length, chapters.length)
  assert.ok(savedToc.receivedBytes < 256, '保存目录的 RETURNING 不应传回章节列表和书籍 patch')
  const chapterCount = await observe(() => repo.getTocChapterCount(userId, bookId, 'edition'))
  const fullChapterSummary = await observe(() => repo.getTocSummary(userId, bookId, 'edition'))
  assert.equal(chapterCount.value, 9999)
  assert.ok(chapterCount.receivedBytes < 128, '目录章节计数只应传回聚合值')
  assert.ok(chapterCount.receivedBytes < fullChapterSummary.receivedBytes * 0.01, '目录计数返回量应小于完整目录摘要的 1%')
  assert.equal(await repo.getTocChapterCount(userId, bookId, 'missing-edition'), null)
  const retainedBookAfter = { sourceId: 'https://example', bookUrl: '/book', name: '书籍详情', rawFields: { large: '详情字段'.repeat(4_000) }, traceRef: 'test', emptyFields: [], fieldErrors: {} }
  await repo.saveToc(userId, { userId, bookId, editionKey: 'bookafter', sourceFingerprint: 'fp', revision: 'r1', chapters: [], bookPatch: { lastCheckTime: 0, totalChapterNum: 0 }, bookAfter: retainedBookAfter })
  const preservedBookAfter = await observe(() => repo.saveToc(userId, { userId, bookId, editionKey: 'bookafter', sourceFingerprint: 'fp', revision: 'r2', chapters: [], bookPatch: { lastCheckTime: 0, totalChapterNum: 0 } }))
  assert.deepEqual(preservedBookAfter.value.bookAfter, retainedBookAfter, '省略 bookAfter 时应保留原有持久化值')
  assert.ok(preservedBookAfter.receivedBytes >= bytes(retainedBookAfter), '仅在需要保留旧 bookAfter 时才读取该持久化字段')
  const content = { userId, bookId, editionKey: 'edition', chapterId: 'large-content', tocRevision: 'r1', sourceFingerprint: 'fp', content: { chapter: { sourceId: 'https://example', bookUrl: 'https://example/book', chapterUrl: '/large-content', index: 0 }, contentType: 'text' as const, raw: '正文'.repeat(16_000), cleaned: '清理正文'.repeat(16_000), pages: ['正文'.repeat(16_000)], resources: [] } }
  const savedContent = await observe(() => repo.saveContent(userId, content))
  assert.equal(savedContent.value.content.cleaned, content.content.cleaned)
  assert.ok(savedContent.receivedBytes < 256, '保存正文的 RETURNING 只应传回 updatedAt')
  t.diagnostic(`目录写入数据库参数 ${savedToc.sentParameterBytes} 字节，RETURNING ${savedToc.receivedBytes} 字节；正文写入参数 ${savedContent.sentParameterBytes} 字节，RETURNING ${savedContent.receivedBytes} 字节；10000 章计数返回 ${chapterCount.receivedBytes} 字节，完整目录摘要返回 ${fullChapterSummary.receivedBytes} 字节`)
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

  const runtimeLease = await repo.acquireSourceRuntimeLease(userId, definitions[0]!.source_id, 'fp-0', 'initial-runtime-lease', 10_000)
  assert.ok(runtimeLease)
  const runtimeSnapshot = { cookies: 'cookie'.repeat(2000), variables: { session: 'state'.repeat(2000) } }
  const savedRuntime = await observe(() => repo.saveSourceRuntimeState(userId, definitions[0]!.source_id, 'fp-0', runtimeLease.leaseToken, runtimeLease.version, runtimeSnapshot))
  assert.deepEqual(savedRuntime.value?.snapshot, runtimeSnapshot)
  assert.ok(savedRuntime.receivedBytes < 128, '保存运行状态只应传回版本号')
  const reacquiredRuntime = await observe(() => repo.acquireSourceRuntimeLease(userId, definitions[0]!.source_id, 'fp-0', 'next-runtime-lease', 10_000))
  assert.deepEqual(reacquiredRuntime.value?.snapshot, runtimeSnapshot)
  assert.equal(reacquiredRuntime.receivedRows, 2, '已有运行状态的租约获取只应返回 set_config 和条件更新结果')
  t.diagnostic(`运行状态保存参数 ${savedRuntime.sentParameterBytes} 字节，RETURNING ${savedRuntime.receivedBytes} 字节；租约获取返回 ${reacquiredRuntime.receivedRows} 行、${reacquiredRuntime.receivedBytes} 字节`)
  await repo.releaseSourceRuntimeLease(userId, definitions[0]!.source_id, 'fp-0', 'next-runtime-lease')
  const expiringLease = await repo.acquireSourceRuntimeLease(userId, definitions[0]!.source_id, 'fp-0', 'expiring-runtime-lease', 10_000)
  assert.ok(expiringLease)
  await admin`update reader.source_runtime_state set lease_until = now() - interval '1 second' where user_id = ${userId} and source_id = ${definitions[0]!.source_id} and source_fingerprint = 'fp-0'`
  const recoveredLease = await repo.acquireSourceRuntimeLease(userId, definitions[0]!.source_id, 'fp-0', 'recovered-runtime-lease', 10_000)
  assert.ok(recoveredLease, '过期租约必须能够重新获取')
  await repo.releaseSourceRuntimeLease(userId, definitions[0]!.source_id, 'fp-0', recoveredLease.leaseToken)
  const competingLeases = await Promise.all([
    repo.acquireSourceRuntimeLease(userId, 'https://race.example/source', 'race-fp', 'race-lease-a', 10_000),
    repo.acquireSourceRuntimeLease(userId, 'https://race.example/source', 'race-fp', 'race-lease-b', 10_000),
  ])
  assert.equal(competingLeases.filter(Boolean).length, 1, '首次创建竞争只能授予一个租约')
  const winningLease = competingLeases.find((lease) => lease !== null)!
  await repo.releaseSourceRuntimeLease(userId, 'https://race.example/source', 'race-fp', winningLease.leaseToken)

  const candidate = { sourceId: definitions[0]!.source_id, sourceFingerprint: 'fp-0', candidate: { sourceId: definitions[0]!.source_id, bookUrl: 'book', name: '书', rawFields: {}, traceRef: 'test' } }
  const metadata = { ...candidate.candidate, emptyFields: [], fieldErrors: {} }
  const created = await repo.createBook(userId, { candidate, metadata, editionKey: 'book-edition', sourceFingerprint: 'fp-0' })
  const { markInputSchema } = await import('../../shared/reading-annotations.ts')
  const markCachedChapter = { paragraphs: ['a'.repeat(1900)], start: { paragraphIndex: 0, offset: 0 }, end: { paragraphIndex: 0, offset: 1 }, truncatedBefore: false, truncatedAfter: false }
  const marks: Array<{ id: string; input: ReturnType<typeof markInputSchema.parse>; cachedChapter: typeof markCachedChapter; version: number }> = []
  for (let index = 0; index < 40; index++) {
    const start = index * 2
    const input = markInputSchema.parse({ editionKey: 'book-edition', sourceFingerprint: 'fp-0', chapterId: 'shared-mark-chapter', chapterUrl: '/shared-mark-chapter', chapterIndex: 0, chapterTitle: '共享章节', tocRevision: 'mark-revision', anchor: { start: { paragraphIndex: 0, offset: start }, end: { paragraphIndex: 0, offset: start + 1 }, exact: 'a', prefix: '', suffix: '', contentHash: 'mark-hash' } })
    const cachedChapter = { ...markCachedChapter, start: input.anchor.start, end: input.anchor.end }
    const mark = await repo.mutateReadingMark(userId, { action: 'save', kind: 'annotations', id: randomUUID(), bookId: created.book.id, input, bookName: '搜索书', author: null, sourceName: '测试源', cachedChapter })
    marks.push({ id: mark.id, input, cachedChapter, version: mark.version })
  }
  const fullSameChapterMarks = await observe(() => repo.listReadingMarks(userId, { kind: 'annotations', bookId: created.book.id, editionKey: 'book-edition', chapterUrl: '/shared-mark-chapter', all: true }))
  const targetMark = marks[0]!
  const markIdentityRead = await observe(() => repo.getReadingMarkIdentity(userId, 'annotations', created.book.id, targetMark.id))
  assert.ok(markIdentityRead.value)
  assert.equal('cachedChapter' in markIdentityRead.value, false)
  assert.ok(markIdentityRead.receivedBytes < bytes(targetMark.cachedChapter) * 0.5, '编辑校验应只读取选中笔记的原文身份投影')
  const editedMark = await observe(() => repo.mutateReadingMark(userId, { action: 'save', kind: 'annotations', id: targetMark.id, bookId: created.book.id, input: { ...targetMark.input, color: 'blue', expectedVersion: targetMark.version }, bookName: '搜索书', author: null, sourceName: '测试源', cachedChapter: targetMark.cachedChapter }))
  assert.equal(editedMark.value.color, 'blue')
  assert.deepEqual(editedMark.value.cachedChapter, targetMark.cachedChapter)
  assert.ok(editedMark.receivedBytes < fullSameChapterMarks.receivedBytes * 0.2, '编辑单条笔记不应读取同章其他笔记的大缓存')
  t.diagnostic('同章 40 条笔记含大缓存：完整读取 ' + fullSameChapterMarks.receivedBytes + ' 字节；选中原文身份 ' + markIdentityRead.receivedBytes + ' 字节；编辑单条笔记读取 ' + editedMark.receivedBytes + ' 字节')

  const organizationCreated = await repo.mutateBookOrganization(userId, { kind: 'create', type: 'booklist', name: '目标书单' })
  const targetList = organizationCreated.lists.find((row) => row.name === '目标书单')!
  const seededLists = Array.from({ length: 50 }, (_, index) => ({ id: randomUUID(), userId, type: 'booklist' as const, name: '大型书单' + index, description: '书单背景'.repeat(128) }))
  await admin`insert into reader.book_lists ${admin(seededLists.map(({ id, userId: ownerId, type, name, description }) => ({ id, user_id: ownerId, type, name, description })))} `
  await admin`insert into reader.book_list_items ${admin(seededLists.map((list) => ({ user_id: userId, book_list_id: list.id, book_id: created.book.id, description: '独立评价'.repeat(128) })))}`
  await admin`insert into reader.book_list_items (user_id,book_list_id,book_id,description) values (${userId},${targetList.id},${created.book.id},${'目标评价'.repeat(128)})`
  const fullOrganization = await observe(() => repo.getBookOrganization(userId))
  const targetedOrganizationUpdate = await observe(() => repo.mutateBookOrganization(userId, { kind: 'review', id: targetList.id, bookId: created.book.id, description: '已修改评价' }))
  assert.equal(targetedOrganizationUpdate.value.lists.find((row) => row.id === targetList.id)?.id, targetList.id)
  assert.equal(targetedOrganizationUpdate.value.items.find((row) => row.bookListId === targetList.id)?.description, '已修改评价')
  assert.ok(targetedOrganizationUpdate.receivedBytes < fullOrganization.receivedBytes * 0.2, '修改一条书单评价不应传输其他书单成员')
  assert.equal((await repo.getBookOrganization(userId)).items.length, 51, '完整组织读取仍应返回全部书单成员')
  t.diagnostic('51 个大书单成员完整状态读取 ' + fullOrganization.receivedBytes + ' 字节；单条评价修改读取 ' + targetedOrganizationUpdate.receivedBytes + ' 字节')
  await repo.saveBookSourceCandidates(userId, created.book.id, [candidate, { ...candidate, sourceFingerprint: 'stale' }])
  const allCandidateRows = await observe(() => repo.listBookSourceCandidates(userId, created.book.id))
  const selectedCandidate = allCandidateRows.value.find((row) => row.sourceFingerprint === 'fp-0')!
  const selectedCandidateRead = await observe(() => repo.getBookSourceCandidate(userId, created.book.id, selectedCandidate.id))
  assert.deepEqual(selectedCandidateRead.value, selectedCandidate)
  assert.ok(selectedCandidateRead.receivedBytes < allCandidateRows.receivedBytes * 0.75, '打开单个候选来源只应传回该候选')
  t.mock.method(repo, 'listAllSourcesForUser', async () => { throw new Error('不应全量读取书源') })
  t.mock.method(repo, 'listSourceStatesForUser', async () => { throw new Error('不应全量读取规则状态') })
  const result = await createReaderRuntime(repo).listBookSources(userId, created.book.id)
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0]?.name, '已更新')
  for (let index = 0; index < 4; index++) {
    const bookUrl = index === 0 ? candidate.candidate.bookUrl : `${candidate.candidate.bookUrl}-${index}`
    const editionCandidate = { ...candidate, candidate: { ...candidate.candidate, bookUrl } }
    await repo.saveEdition(userId, created.book.id, { candidate: editionCandidate, metadata: { ...metadata, bookUrl, name: `大版本${index}`.repeat(4096) }, editionKey: `target-edition-${index}`, sourceFingerprint: 'fp-0' })
  }
  const fullEditionRead = await observe(() => repo.listEditions(userId, created.book.id))
  const expectedEdition = fullEditionRead.value.find((edition) => edition.sourceId === candidate.sourceId && edition.sourceFingerprint === candidate.sourceFingerprint && edition.bookUrl === candidate.candidate.bookUrl)!
  const targetEditionRead = await observe(() => repo.getBookEditionBySource(userId, created.book.id, candidate.sourceId, candidate.sourceFingerprint, candidate.candidate.bookUrl))
  assert.deepEqual(targetEditionRead.value, expectedEdition)
  assert.ok(targetEditionRead.receivedBytes < fullEditionRead.receivedBytes * 0.75, '打开单个来源版本只应传回目标版本')
  t.diagnostic(`5 个书籍版本返回字节代理值：完整列表 ${fullEditionRead.receivedBytes}，目标版本 ${targetEditionRead.receivedBytes}`)
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
