import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema.ts'

export type ReaderDb = PostgresJsDatabase<typeof schema>
export type ReaderTransaction = Parameters<Parameters<ReaderDb['transaction']>[0]>[0]

let database: ReaderDb | undefined
let connection: ReturnType<typeof postgres> | undefined

export function getReaderDb(): ReaderDb {
  if (database !== undefined) return database
  const url = process.env.DATABASE_URL?.trim() ?? ''
  if (url.length === 0) throw new Error('DATABASE_URL 未配置')
  connection = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require',
  })
  database = drizzle(connection, { schema })
  return database
}

export async function withUser<T>(userId: string, operation: (transaction: ReaderTransaction) => Promise<T>): Promise<T> {
  return getReaderDb().transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.user_id', ${userId}, true)`)
    return operation(transaction)
  })
}

export async function withReaderDb<T>(operation: (database: ReaderDb) => Promise<T>): Promise<T> {
  return operation(getReaderDb())
}

export async function closeReaderDb(): Promise<void> {
  if (connection === undefined) return
  await connection.end({ timeout: 5 })
  connection = undefined
  database = undefined
}
