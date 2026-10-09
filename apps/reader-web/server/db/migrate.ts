import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL?.trim() ?? ''
if (url.length === 0) throw new Error('DATABASE_URL 未配置')
const client = postgres(url, { max: 1, prepare: false, ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require' })
try {
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) })
} finally {
  await client.end({ timeout: 5 })
}
