import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { registerReadingMarksApi } from '../server/reading-marks-api.ts'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { chapterIdFor } from '../server/runtime/reader-runtime.ts'
import { MARK_COLORS, MarkError, changeMark, markInputSchema, markPage, type MarkCommand, type ReadingMark } from '../shared/reading-annotations.ts'
import { createAnchor, markedFragments, resolveAnchor, textFingerprint } from '../src/lib/reader-annotations.ts'
import { createWebBackup, restoreWebBackup } from '../server/backup.ts'
import { createBackupZip, readBackupZip, editionKey as sharedEditionKey } from '@legado/reader-backup'

const user = randomUUID(); const other = randomUUID()
async function setup() {
  const repo = new MemoryReaderRepository()
  const metadata = { sourceId: 'https://marks.test', bookUrl: 'https://marks.test/book', name: '山间来信', author: '作者', traceRef: '', rawFields: {}, emptyFields: [], fieldErrors: {} }
  const key = sharedEditionKey(metadata.sourceId, metadata.bookUrl)
  const created = await repo.createBook(user, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: key, sourceFingerprint: 'fp' })
  const chapter = { sourceId: metadata.sourceId, bookUrl: metadata.bookUrl, chapterUrl: metadata.bookUrl + '/1', index: 0, title: '第一章', rawFields: {}, traceRef: '' }
  await repo.saveToc(user, { userId: user, bookId: created.book.id, editionKey: key, sourceFingerprint: 'fp', revision: 'rev', chapters: [chapter], bookPatch: { lastCheckTime: 0, totalChapterNum: 1 }, bookAfter: metadata })
  const cleaned = '慢下来，才能看见光。\n读书有时就是如此。'
  await repo.saveContent(user, { userId: user, bookId: created.book.id, editionKey: key, sourceFingerprint: 'fp', tocRevision: 'rev', chapterId: chapterIdFor(chapter), content: { chapter, cleaned, raw: cleaned, contentType: 'text', pages: [cleaned], resources: [] } })
  const input = markInputSchema.parse({ editionKey: key, sourceFingerprint: 'fp', chapterId: chapterIdFor(chapter), chapterUrl: chapter.chapterUrl, chapterIndex: 0, chapterTitle: chapter.title, tocRevision: 'rev', anchor: createAnchor(cleaned.split('\n'), { paragraphIndex: 0, offset: 0 }, { paragraphIndex: 0, offset: 3 }, textFingerprint(cleaned)), note: '想起日落' })
  const app = new Hono<{ Variables: { userId: string } }>()
  registerReadingMarksApi(app, () => repo, async (c) => { const token = c.req.header('Authorization'); if (!token) return c.json({ error: { message: '需要登录' } }, 401); c.set('userId', token === 'other' ? other : user); return undefined })
  const path = '/api/books/' + created.book.id + '/annotations/' + randomUUID()
  const request = (url: string, method = 'GET', body?: unknown, token = 'owner') => app.request('http://localhost' + url, { method, headers: { Authorization: token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { repo, input, app, path, request, bookId: created.book.id }
}

test('文字锚点跨段、UTF-16、正文改动唯一定位及重复歧义', () => {
  const texts = ['甲😀乙', '下一段']; const anchor = createAnchor(texts, { paragraphIndex: 0, offset: 1 }, { paragraphIndex: 1, offset: 2 }, 'old')
  assert.equal(anchor.exact, '😀乙\n下一')
  assert.equal(resolveAnchor(texts, anchor, 'old')?.start.offset, 1)
  const moved = resolveAnchor(['前置', ...texts], anchor, 'changed')
  assert.deepEqual(moved?.start, { paragraphIndex: 1, offset: 1 })
  assert.equal(resolveAnchor(['完全不同'], anchor, 'changed'), null)
  const ambiguous = { ...createAnchor(['重复'], { paragraphIndex: 0, offset: 0 }, { paragraphIndex: 0, offset: 2 }, 'old'), prefix: '', suffix: '' }
  assert.equal(resolveAnchor(['重复重复'], ambiguous, 'new'), null)
})

test('跨段标记片段保留原文，无额外字符和重叠渲染', () => {
  const anchor = createAnchor(['甲乙丙', '丁戊己'], { paragraphIndex: 0, offset: 1 }, { paragraphIndex: 1, offset: 1 }, 'hash')
  const row = { id: randomUUID(), anchor } as ReadingMark
  assert.deepEqual(markedFragments('甲乙丙', 0, [row]).map((r) => [r.text, Boolean(r.mark)]), [['甲', false], ['乙丙', true]])
  assert.deepEqual(markedFragments('丁戊己', 1, [row]).map((r) => [r.text, Boolean(r.mark)]), [['丁', true], ['戊己', false]])
  assert.equal(MARK_COLORS.length, 5)
})

test('鉴权、创建默认橙色、五色编辑、软删除与恢复', async () => {
  const { app, request, path, input, bookId } = await setup()
  assert.equal((await app.request('http://localhost/api/annotations')).status, 401)
  assert.equal((await request(path, 'PUT', input, 'other')).status, 404)
  const response = await request(path, 'PUT', input); assert.equal(response.status, 200)
  let row = (await response.json()).item as ReadingMark
  assert.equal(row.color, 'orange'); assert.equal(row.note, '想起日落')
  assert.equal((await request(path, 'PUT', input)).status, 200)
  for (const color of MARK_COLORS) {
    const changed = await request(path, 'PUT', { ...input, color: color.value, expectedVersion: row.version }); assert.equal(changed.status, 200)
    row = (await changed.json()).item
  }
  assert.equal((await request(path, 'PUT', { ...input, expectedVersion: 0 })).status, 409)
  assert.equal((await request(path, 'DELETE', { expectedVersion: row.version }, 'other')).status, 404)
  const removed = await request(path, 'DELETE', { expectedVersion: row.version }); assert.equal(removed.status, 200); row = (await removed.json()).item
  assert.equal((await (await request('/api/annotations')).json()).items.length, 0)
  assert.equal((await (await request('/api/annotations?deleted=true')).json()).items[0].id, row.id)
  const restored = await request(path + '/restore', 'POST', { expectedVersion: row.version }); assert.equal(restored.status, 200)
  assert.equal((await restored.json()).item.note, '想起日落')
  assert.equal((await (await request('/api/annotations?bookId=' + bookId + '&q=日落')).json()).items.length, 1)
  assert.equal((await (await request('/api/annotations', 'GET', undefined, 'other')).json()).items.length, 0)
  assert.equal((await request(path, 'PUT', { ...input, color: 'red' })).status, 400)
})

test('改色时锚点 JSON 键顺序变化不应被当作移动原文位置', async () => {
  const { repo, request, path, input } = await setup()
  const created = await request(path, 'PUT', input)
  assert.equal(created.status, 200)
  const mark = (await created.json()).item as ReadingMark
  const listMarks = repo.listReadingMarks.bind(repo)
  repo.listReadingMarks = async (userId, query) => {
    const page = await listMarks(userId, query)
    return {
      ...page,
      items: page.items.map((item) => ({ ...item, anchor: {
        contentHash: item.anchor.contentHash,
        suffix: item.anchor.suffix,
        prefix: item.anchor.prefix,
        exact: item.anchor.exact,
        end: item.anchor.end,
        start: item.anchor.start,
      } })),
    }
  }
  const changed = await request(path, 'PUT', { ...input, color: 'blue', expectedVersion: mark.version })
  assert.equal(changed.status, 200)
  const updated = (await changed.json()).item as ReadingMark
  assert.equal(updated.color, 'blue')
  assert.deepEqual(updated.anchor, mark.anchor)
})

test('过期正文、部分重叠与恢复冲突不会丢失数据', async () => {
  const { request, repo, path, input, bookId } = await setup()
  assert.equal((await request(path, 'PUT', { ...input, anchor: { ...input.anchor, contentHash: 'old' } })).status, 409)
  const row = (await (await request(path, 'PUT', input)).json()).item as ReadingMark
  const overlap = { ...input, anchor: createAnchor(['慢下来，才能看见光。', '读书有时就是如此。'], { paragraphIndex: 0, offset: 1 }, { paragraphIndex: 0, offset: 4 }, input.anchor.contentHash) }
  assert.equal((await request(path.replace(row.id, randomUUID()), 'PUT', overlap)).status, 409)
  await request(path, 'DELETE', { expectedVersion: row.version })
  await request(path.replace(row.id, randomUUID()), 'PUT', overlap)
  assert.equal((await request(path + '/restore', 'POST', { expectedVersion: 1 })).status, 409)
  assert.equal((await repo.listReadingMarks(user, { kind: 'annotations', bookId, deleted: true })).items.length, 1)
})

test('搜索字面百分号和下划线、稳定游标、筛选条件绑定', async () => {
  const { input, bookId } = await setup()
  const command: MarkCommand = { action: 'save', kind: 'annotations', id: randomUUID(), bookId, bookName: '书', author: null, sourceName: '书源', cachedChapter: null, input }
  const base = changeMark([], user, command)
  const rows = Array.from({ length: 55 }, (_, n) => ({ ...base, id: randomUUID(), createdAt: new Date(1700000000000 + n * 1000).toISOString(), note: n === 0 ? '100%_字面' : '一般' }))
  assert.equal(markPage(rows, { kind: 'annotations', q: '%_' }).items.length, 1)
  const query = { kind: 'annotations' as const }; const first = markPage(rows, query); assert.equal(first.items.length, 50); assert.ok(first.nextCursor)
  const withoutCursorRecord = rows.filter((r) => r.id !== first.items.at(-1)!.id)
  assert.equal(markPage(withoutCursorRecord, { ...query, cursor: first.nextCursor }).items.length, 5)
  assert.throws(() => markPage(rows, { ...query, q: 'different', cursor: first.nextCursor! }), MarkError)
})

test('同账号相同记录 id 不能覆盖其他书籍，双并发更新只有一次成功', async () => {
  const { repo, input, bookId } = await setup(); const id = randomUUID()
  const command = { action: 'save' as const, kind: 'annotations' as const, id, bookId, input, bookName: '书', author: null, sourceName: '书源', cachedChapter: null }
  await repo.mutateReadingMark(user, command)
  await assert.rejects(repo.mutateReadingMark(user, { ...command, bookId: randomUUID() }))
  const updates = await Promise.allSettled([repo.mutateReadingMark(user, { ...command, input: { ...input, color: 'blue', expectedVersion: 0 } }), repo.mutateReadingMark(user, { ...command, input: { ...input, color: 'green', expectedVersion: 0 } })])
  assert.equal(updates.filter((r) => r.status === 'fulfilled').length, 1)
})

test('Web备份包含活动及已删除笔记，旧备份缺字段保留现有笔记', async () => {
  const { repo, request, path, input } = await setup()
  const row = (await (await request(path, 'PUT', input)).json()).item as ReadingMark
  await request(path, 'DELETE', { expectedVersion: row.version })
  const zip = await createWebBackup(repo, user); const archive = await readBackupZip(zip)
  assert.ok(archive.files.has('reading/annotations.json'))
  const restored = new MemoryReaderRepository(); await restoreWebBackup(restored, user, zip, ['bookshelf', 'reading'])
  assert.equal((await restored.listReadingMarks(user, { kind: 'annotations', deleted: true })).items[0]?.note, input.note)
  const old = createBackupZip(archive.manifest.files.filter((f) => !f.path.startsWith('reading/')).map((f) => ({ path: f.path, category: f.category, data: archive.files.get(f.path)! })), { producer: archive.manifest.producer })
  await restoreWebBackup(restored, user, old, ['reading'])
  assert.equal((await restored.listReadingMarks(user, { kind: 'annotations', deleted: true })).items.length, 1)
})

test('设置页和阅读抽屉的书签笔记都按创建时间倒序', async () => {
  const { input, bookId } = await setup()
  const base = changeMark([], user, { action: 'save', kind: 'annotations', id: randomUUID(), bookId, input, bookName: '书', author: null, sourceName: '书源', cachedChapter: null })
  const rows = [{ ...base, id: randomUUID(), chapterIndex: 0, createdAt: '2026-01-01T00:00:00.000Z' }, { ...base, id: randomUUID(), chapterIndex: 5, createdAt: '2026-02-01T00:00:00.000Z' }]
  assert.equal(markPage(rows, { kind: 'annotations', bookId, order: 'created' }).items[0]?.chapterIndex, 5)
  assert.equal(markPage(rows, { kind: 'annotations', bookId }).items[0]?.chapterIndex, 5)
  assert.equal(markPage(rows, { kind: 'annotations', bookId, order: 'position' }).items[0]?.chapterIndex, 0)
})

test('恢复缺少批注文件的旧书架备份时保留笔记依赖书籍', async () => {
  const { repo, request, path, input, bookId } = await setup()
  await request(path, 'PUT', input)
  const empty = await readBackupZip(await createWebBackup(new MemoryReaderRepository(), user))
  const old = createBackupZip(empty.manifest.files.filter((f) => !f.path.startsWith('reading/')).map((f) => ({ path: f.path, category: f.category, data: empty.files.get(f.path)! })), { producer: empty.manifest.producer })
  await restoreWebBackup(repo, user, old, ['bookshelf', 'reading'])
  assert.ok(await repo.getBook(user, bookId))
  assert.equal((await repo.listReadingMarks(user, { kind: 'annotations' })).items.length, 1)
  await readBackupZip(await createWebBackup(repo, user))
})

test('服务端拒绝超界及伪造摘录锚点，HTML实体和嵌套文字保持精确', async () => {
  const { repo, request, path, input, bookId } = await setup()
  assert.equal((await request(path, 'PUT', { ...input, anchor: { ...input.anchor, exact: '伪造摘录' } })).status, 400)
  assert.equal((await request(path, 'PUT', { ...input, anchor: { ...input.anchor, end: { paragraphIndex: 99, offset: 0 } } })).status, 400)
  const cleaned = '<p>甲&amp;<b>乙</b><br>丙</p><script>移除</script><p>丁</p>'
  const chapter = { sourceId: 'https://marks.test', bookUrl: 'https://marks.test/book', chapterUrl: input.chapterUrl, title: input.chapterTitle, index: input.chapterIndex, traceRef: '', rawFields: {} }
  await repo.saveContent(user, { userId: user, bookId, editionKey: input.editionKey, chapterId: input.chapterId, sourceFingerprint: input.sourceFingerprint, tocRevision: input.tocRevision, content: { chapter, cleaned, raw: cleaned, contentType: 'html', pages: [cleaned], resources: [] } })
  const anchor = createAnchor(['甲&乙丙丁'], { paragraphIndex: 0, offset: 1 }, { paragraphIndex: 0, offset: 4 }, textFingerprint(cleaned))
  const response = await request(path, 'PUT', { ...input, anchor }); assert.equal(response.status, 200); assert.equal((await response.json()).item.anchor.exact, '&乙丙')
})

test('备份校验拒绝重叠活动标记，导入失败保留原数据', async () => {
  const { repo, request, path, input } = await setup()
  const row = (await (await request(path, 'PUT', input)).json()).item as ReadingMark
  const archive = await readBackupZip(await createWebBackup(repo, user))
  const overlapping = { ...row, id: randomUUID(), anchor: createAnchor(['慢下来，才能看见光。', '读书有时就是如此。'], { paragraphIndex: 0, offset: 1 }, { paragraphIndex: 0, offset: 4 }, input.anchor.contentHash) }
  const data = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, data: [row, overlapping] }))
  const invalid = createBackupZip(archive.manifest.files.map((f) => ({ path: f.path, category: f.category, data: f.path === 'reading/annotations.json' ? data : archive.files.get(f.path)! })), { producer: archive.manifest.producer })
  await assert.rejects(restoreWebBackup(repo, user, invalid, ['reading']), /重叠/u)
  assert.equal((await repo.listReadingMarks(user, { kind: 'annotations' })).items[0]?.id, row.id)
})

test('书单保留的同ID书籍冲突时同步重映射导入笔记', async () => {
  const { repo, request, path, input, bookId } = await setup()
  await request(path, 'PUT', input)
  const archive = await readBackupZip(await createWebBackup(repo, user))
  const withoutLists = createBackupZip(archive.manifest.files.filter((f) => f.path !== 'book-lists.json').map((f) => ({ path: f.path, category: f.category, data: archive.files.get(f.path)! })), { producer: archive.manifest.producer })
  const target = new MemoryReaderRepository()
  const metadata = { sourceId: 'https://local.test', bookUrl: 'https://local.test/other', name: '本地另一本书', traceRef: '', rawFields: {}, emptyFields: [], fieldErrors: {} }
  await target.createBook(user, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'local-fp', candidate: metadata }, metadata, editionKey: sharedEditionKey(metadata.sourceId, metadata.bookUrl), sourceFingerprint: 'local-fp' })
  const local = await target.getBackupSnapshot(user)
  for (const entry of local.books) { entry.book.id = bookId; for (const edition of entry.editions) edition.bookId = bookId }
  for (const row of local.bookshelf) row.bookId = bookId
  await target.restoreBackupSnapshot(user, local, ['bookshelf', 'reading'])
  const org = await target.mutateBookOrganization(user, { kind: 'create', type: 'booklist', name: '保留书单' })
  await target.mutateBookOrganization(user, { kind: 'add', id: org.lists[0]!.id, bookId })
  await restoreWebBackup(target, user, withoutLists, ['bookshelf', 'reading'])
  const note = (await target.listReadingMarks(user, { kind: 'annotations' })).items[0]!
  assert.notEqual(note.bookId, bookId)
  assert.equal((await target.getBook(user, note.bookId))?.name, '山间来信')
  assert.equal((await target.getBook(user, bookId))?.name, '本地另一本书')
})
