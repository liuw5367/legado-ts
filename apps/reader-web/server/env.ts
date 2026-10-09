import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configuredPath = process.env.READER_WEB_ENV_FILE?.trim()
const envFile = configuredPath === undefined || configuredPath.length === 0
  ? resolve(appDirectory, '.env.local')
  : resolve(configuredPath)

if (existsSync(envFile)) process.loadEnvFile(envFile)
