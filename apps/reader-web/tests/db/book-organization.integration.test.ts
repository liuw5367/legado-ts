import { editionKey } from '@legado/reader-backup'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb } from '../../server/db/client.ts'

const testUrl = process.env.READER_WEB_TEST_DATABASE_URL

test('真实数据库书单、分组、RLS、移动回滚与启动设置', { skip: testUrl === undefined ? '需要独立READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  assert.ok(testUrl)
  const admin = postgres(testUrl, { max: 1, onnotice: () => undefined })
  const role = `organization_${randomUUID().replaceAll('-', '')}`
  let client: ReturnType<typeof postgres> | undefined
  t.after(async () => { await closeReaderDb(); await client?.end(); await admin`drop owned by ${admin(role)}`; await admin`drop role ${admin(role)}`; await admin.end() })
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select, insert, update, delete on all tables in schema reader to ${admin(role)}`
  const url = new URL(testUrl); url.username = role; process.env.DATABASE_URL = url.toString()
  client = postgres(url.toString(), { max: 1 })
  const repo = new PostgresReaderRepository(); const user = randomUUID(); const other = randomUUID()
  const metadata = { sourceId: 'https://book.test', bookUrl: 'https://book.test/1', name: '事务书', author: '作者', traceRef: '', rawFields: {}, emptyFields: [], fieldErrors: {} }
  const created = await repo.createBook(user, { candidate: { sourceId: metadata.sourceId, sourceFingerprint: 'fp', candidate: metadata }, metadata, editionKey: editionKey(metadata.sourceId, metadata.bookUrl), sourceFingerprint: 'fp' })
  assert.equal((await repo.setCustomCover(user, created.book.id, 'https://covers.test/custom.jpg'))?.customCoverUrl, 'https://covers.test/custom.jpg')
  assert.equal(await repo.setCustomCover(other, created.book.id, 'https://covers.test/wrong.jpg'), null)
  const org = await repo.mutateBookOrganization(user, { kind: 'create', type: 'booklist', name: '重读' }); const list = org.lists[0]!
  await repo.mutateBookOrganization(user, { kind: 'add', id: list.id, bookId: created.book.id })
  await repo.mutateBookOrganization(user, { kind: 'review', id: list.id, bookId: created.book.id, description: '独立评价' })
  assert.equal((await repo.getBookOrganization(user)).items[0]?.description, '独立评价')
  assert.deepEqual(await repo.getBookOrganization(other), { lists: [], items: [] })
  await assert.rejects(repo.mutateBookOrganization(other, { kind: 'move', id: list.id, bookId: created.book.id }))
  assert.equal(await repo.isOnBookshelf(user, created.book.id), true)
  const groups = await repo.mutateBookOrganization(user, { kind: 'create', type: 'shelf_group', name: '科幻' }); const group = groups.lists.find((row) => row.type === 'shelf_group')!
  await repo.mutateBookOrganization(user, { kind: 'assign', bookId: created.book.id, groupId: group.id })
  await repo.saveSettings(user, { general: { bookshelfInitialGroup: group.id } })
  assert.equal((await repo.getHome(user)).bookshelf[0]?.groupId, group.id)
  await assert.rejects(repo.saveSettings(other, { general: { bookshelfInitialGroup: group.id } }))
  // 绕过 Repository 过滤验证两个新表均强制账号隔离。
  await client.begin(async (sql) => { await sql`select set_config('app.user_id', ${other}, true)`; assert.equal((await sql`select * from reader.book_lists`).length, 0); assert.equal((await sql`select * from reader.book_list_items`).length, 0) })
  await assert.rejects(client.begin(async (sql) => { await sql`select set_config('app.user_id', ${other}, true)`; await sql`insert into reader.book_lists (user_id,name) values (${user},'越权')` }), /row-level security/u)
  // 在移动的第二次写入处注入真实数据库失败，验证先前加入被回滚。
  await repo.mutateBookOrganization(user, { kind: 'remove', id: list.id, bookId: created.book.id })
  await admin`create function reader.fail_organization_delete() returns trigger language plpgsql as 'begin raise exception ''injected shelf delete failure''; end'`
  await admin`create trigger fail_organization_delete before delete on reader.bookshelf for each row execute function reader.fail_organization_delete()`
  try { await assert.rejects(repo.mutateBookOrganization(user, { kind: 'move', id: list.id, bookId: created.book.id }), (error: unknown) => error instanceof Error && error.cause instanceof Error && error.cause.message.includes('injected shelf')) }
  finally { await admin`drop trigger fail_organization_delete on reader.bookshelf`; await admin`drop function reader.fail_organization_delete()` }
  assert.equal(await repo.isOnBookshelf(user, created.book.id), true); assert.equal((await repo.getBookOrganization(user)).items.length, 0)
  await repo.mutateBookOrganization(user, { kind: 'delete', type: 'shelf_group', id: group.id })
  assert.equal((await repo.getSettings(user)).general.bookshelfInitialGroup, 'all'); assert.equal((await repo.getHome(user)).bookshelf[0]?.groupId, null)
  await repo.mutateBookOrganization(user, { kind: 'move', id: list.id, bookId: created.book.id })
  assert.equal(await repo.isOnBookshelf(user, created.book.id), false); assert.ok(await repo.getBook(user, created.book.id))
  await repo.addToBookshelf(user, created.book.id)
  const organization = await repo.mutateBookOrganization(user, { kind: 'create', type: 'shelf_group', name: '恢复组' })
  const restoredGroup = organization.lists.find((row) => row.type === 'shelf_group')!
  await repo.mutateBookOrganization(user, { kind: 'assign', bookId: created.book.id, groupId: restoredGroup.id })
  await repo.saveSettings(user, { general: { bookshelfInitialGroup: restoredGroup.id } })
  const snapshot = await repo.getBackupSnapshot(user)
  await repo.restoreBackupSnapshot(user, snapshot, ['bookshelf', 'reading', 'settings'])
  const after = await repo.getBackupSnapshot(user)
  assert.equal(after.books.find((row) => row.book.id === created.book.id)?.book.customCoverUrl, 'https://covers.test/custom.jpg')
  const newGroup = after.organization?.lists.find((row) => row.name === '恢复组')
  assert.ok(newGroup)
  assert.equal(after.bookshelf[0]?.groupId, newGroup.id)
  assert.equal(after.settings.general.bookshelfInitialGroup, newGroup.id)
  assert.equal(after.organization?.items.length, 1)

})
