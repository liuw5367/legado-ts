import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { PostgresReaderRepository } from '../../server/db/repository.ts'
import { closeReaderDb, getReaderDb } from '../../server/db/client.ts'
import { latestSearchHistory } from '../../shared/search-history.ts'

const url = process.env.READER_WEB_TEST_DATABASE_URL

test('搜索历史 SQL 与 JS 的 trim/NFC、最新请求、50词限制及整组删除语义一致', { skip: !url ? '需要独立 READER_WEB_TEST_DATABASE_URL' : false }, async (t) => {
  const admin = postgres(url!, { max: 1, onnotice: () => undefined })
  const user = randomUUID(), other = randomUUID(), role = 'home_' + randomUUID().replaceAll('-', '')
  await migrate(drizzle(admin), { migrationsFolder: fileURLToPath(new URL('../../server/db/migrations', import.meta.url)) })
  await admin`create role ${admin(role)} login`
  t.after(async () => { await closeReaderDb(); await admin`delete from reader.search_history where user_id in (${user},${other})`; await admin`drop owned by ${admin(role)}`; await admin`drop role ${admin(role)}`; await admin.end() })
  await admin`grant usage on schema reader to ${admin(role)}`
  await admin`grant select,update on all tables in schema reader to ${admin(role)}`
  const appUrl = new URL(url!); appUrl.username = role
  process.env.DATABASE_URL = appUrl.toString()
  const input = Array.from({ length: 70 }, (_, index) => ({ id: randomUUID(), keyword: index < 60 ? `关键词${index}` : index % 2 ? '\u3000cafe\u0301\u00a0' : ' café ', createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() }))
  for (const row of input) await admin`insert into reader.search_history (id,user_id,search_id,keyword,status,created_at) values (${row.id},${user},${randomUUID()},${row.keyword},'success',${row.createdAt})`
  await admin`insert into reader.search_history (user_id,search_id,keyword,status) values (${other},${randomUUID()},'其他用户','success')`
  const repository = new PostgresReaderRepository()
  const client = (getReaderDb() as ReturnType<typeof getReaderDb> & { $client: ReturnType<typeof postgres> }).$client
  await repository.getSearchHistory(user)
  const original = client.options.transform.row.from
  let returnedRows = 0
  client.options.transform.row.from = (row) => { returnedRows++; return original ? original(row) : row }
  t.after(() => { client.options.transform.row.from = original })
  const expected = latestSearchHistory(input).slice(0, 50)
  const actual = await repository.getSearchHistory(user)
  assert.deepEqual(actual.map((row) => row.id), expected.map((row) => row.id))
  assert.ok(returnedRows <= 51, '数据库只能返回50条展示结果和事务身份设置结果')
  assert.equal(actual.length, 50)
  assert.deepEqual(await repository.getBookshelf(user), [])
  assert.deepEqual(await repository.getReadingHistory(user), [])
  assert.equal(await repository.deleteSearchHistory(other, actual[0]!.id), false)
  assert.equal(await repository.deleteSearchHistory(user, actual[0]!.id), true)
  assert.equal((await repository.getSearchHistory(user)).some((row) => row.keyword.trim().normalize('NFC') === 'café'), false)
})
