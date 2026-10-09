import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

test('Vercel 配置保留 Hono API、SPA 深链和流式请求约束', async () => {
  const [configSource, entrySource, buildScriptSource] = await Promise.all([
    readFile(resolve(repositoryRoot, 'vercel.json'), 'utf8'),
    readFile(resolve(repositoryRoot, 'server.ts'), 'utf8'),
    readFile(resolve(repositoryRoot, 'scripts/build-reader-web-vercel.mjs'), 'utf8'),
  ])
  const config = JSON.parse(configSource) as {
    framework?: string
    buildCommand?: string
    functions?: Record<string, { maxDuration?: number; supportsCancellation?: boolean }>
    headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>
    rewrites?: Array<{ source?: string; destination?: string }>
  }

  assert.equal(config.framework, 'hono')
  assert.equal(config.buildCommand, 'pnpm run build:web:vercel')
  assert.deepEqual(config.functions?.['server.ts'], { maxDuration: 60, supportsCancellation: true })
  assert.match(entrySource, /from ['"]hono['"]/u)
  assert.match(buildScriptSource, /apps\/reader-web\/dist/u)
  assert.match(buildScriptSource, /public/u)

  const apiHeader = config.headers?.find((item) => item.source === '/api/:path*')
  assert.deepEqual(apiHeader?.headers, [{ key: 'Cache-Control', value: 'no-store' }])

  const spaRewrite = config.rewrites?.find((item) => item.destination === '/index.html')
  assert.equal(spaRewrite?.source, '/((?!api(?:/|$)|static(?:/|$)).*)')
  const spaPattern = new RegExp(`^${spaRewrite?.source}$`, 'u')
  assert.equal(spaPattern.test('/api/health'), false)
  assert.equal(spaPattern.test('/static/js/index.js'), false)
  assert.equal(spaPattern.test('/account/settings'), true)
  assert.match(buildScriptSource, /tsconfig\.build\.json/u)
  assert.match(buildScriptSource, /@legado\/source-node', 'build/u)
  assert.match(buildScriptSource, /@legado\/reader-web', 'build/u)
})
