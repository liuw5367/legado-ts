import '../env.ts'
import { and, asc, gt, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sourceDomainInfo } from '../../shared/source-domain.ts'
import { userSources } from './schema.ts'
import type { ReaderDb } from './client.ts'
import * as schema from './schema.ts'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultBatchSize = 500

/** Re-runnable keyset backfill: only reads source IDs and updates rows that remain unkeyed. */
export async function backfillSourceDomainKeys(database: ReaderDb, batchSize = defaultBatchSize): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new RangeError('batch size must be between 1 and 5000')
  let cursor: string | undefined
  let scanned = 0
  while (true) {
    const rows = await database.transaction(async (transaction) => {
      const batch = await transaction.select({ sourceUuid: userSources.sourceUuid, sourceId: userSources.sourceId }).from(userSources)
        .where(and(isNull(userSources.domainKey), cursor === undefined ? undefined : gt(userSources.sourceUuid, cursor)))
        .orderBy(asc(userSources.sourceUuid)).limit(batchSize)
      if (batch.length > 0) {
        const mappings = batch.map((row) => sql`(${row.sourceUuid}::uuid, ${sourceDomainInfo(row.sourceId).key}::text)`)
        await transaction.execute(sql`update reader.user_sources as target
          set domain_key = mapping.domain_key
          from (values ${sql.join(mappings, sql`, `)}) as mapping(source_uuid, domain_key)
          where target.source_uuid = mapping.source_uuid and target.domain_key is null`)
      }
      return batch
    })
    if (rows.length === 0) break
    scanned += rows.length
    cursor = rows.at(-1)!.sourceUuid
  }
  return scanned
}

function parseArgs(args: string[]) {
  let batchSize = defaultBatchSize
  let allowNonlocal = false
  for (const arg of args) {
    if (arg === '--allow-nonlocal') allowNonlocal = true
    else if (arg.startsWith('--batch-size=')) batchSize = Number(arg.slice('--batch-size='.length))
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new RangeError('batch size must be between 1 and 5000')
  return { batchSize, allowNonlocal }
}

async function run() {
  const { batchSize, allowNonlocal } = parseArgs(process.argv.slice(2))
  const connectionString = process.env.DATABASE_URL?.trim()
  if (!connectionString) throw new Error('DATABASE_URL 未配置')
  const url = new URL(connectionString)
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (!localHosts.has(url.hostname.toLowerCase()) && !allowNonlocal) throw new Error('Refusing a non-local database; use --allow-nonlocal only for an explicitly authorized backfill')
  const client = postgres(connectionString, { max: 1, prepare: false, ssl: localHosts.has(url.hostname.toLowerCase()) ? false : 'require' })
  try {
    const [role] = await client`select rolsuper or rolbypassrls as can_bypass_rls from pg_roles where rolname = current_user`
    if (role?.can_bypass_rls !== true) throw new Error('The database role must have BYPASSRLS to backfill all accounts')
    const scanned = await backfillSourceDomainKeys(drizzle(client, { schema }), batchSize)
    console.info(`Scanned ${scanned} unkeyed source records.`)
  } finally {
    await client.end({ timeout: 5 })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run()
}
