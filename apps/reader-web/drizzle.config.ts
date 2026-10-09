import type { Config } from 'drizzle-kit'

const databaseUrl = process.env.DATABASE_URL?.trim()

export default {
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  ...(databaseUrl === undefined || databaseUrl.length === 0 ? {} : { dbCredentials: { url: databaseUrl } }),
  strict: true,
  verbose: true,
} satisfies Config
