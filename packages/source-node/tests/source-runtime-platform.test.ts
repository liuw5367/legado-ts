import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { NormalizedSource, SourceRuntimePlatformContext } from '../../source-core/src/index.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'
import { NodeArchiveHost } from '../src/archive.ts'
import { NodeSourceConcurrency } from '../src/source-concurrency.ts'
import { NodeSourceRuntimePlatform } from '../src/runtime-platform.ts'

const execFile = promisify(execFileCallback)
const source = { bookSourceUrl: 'https://platform.fixture.invalid', bookSourceName: '平台 fixture' } as NormalizedSource

test('Node 平台桥接提供 Android 的转换、设备、配置和导航上下文', async () => {
  const platform = new NodeSourceRuntimePlatform({
    deviceSeed: 'platform-test',
    appVariant: 'web-test',
    readBookConfig: { reverseToc: true },
    themeMode: '2',
    themeConfig: { dark: true },
    sourceNavigationContext: (context: SourceRuntimePlatformContext) => ({ source: context.source.bookSourceUrl, stage: context.workflowStage }),
  })
  const host = new SourceRuleHost({ platform })
  const output = await host.evaluate({
    source,
    stage: 'search',
    field: 'fixture',
    rule: '@js:JSON.stringify({t2s: java.t2s("繁體中文"), s2t: java.s2t("简体中文"), id: java.androidId(), same: java.androidId() === java.deviceID(), variant: java.getAppVariant(), read: java.getReadBookConfig(), readMap: java.getReadBookConfigMap().reverseToc, theme: java.getThemeMode(), themeMap: java.getThemeConfigMap().dark, nav: java.getSourceNavigationContext()})',
    content: '',
  })
  assert.equal(output.status, 'success', output.message)
  assert.deepEqual(JSON.parse(String(output.value)), {
    t2s: '繁体中文',
    s2t: '簡體中文',
    id: '50ffc16cfb457cfb',
    same: true,
    variant: 'web-test',
    read: JSON.stringify({ reverseToc: true }),
    readMap: true,
    theme: '2',
    themeMap: true,
    nav: { source: source.bookSourceUrl, stage: 'search' },
  })
})

test('Node 平台桥接可以注入浏览器、媒体和宿主动作能力', async () => {
  const calls: Array<{ capability: string; input: unknown; source: string }> = []
  const platform = new NodeSourceRuntimePlatform({
    invoke: (capability, input, context) => {
      calls.push({ capability, input, source: context.source.bookSourceUrl })
      if (capability === 'java.openUrl') return { accepted: true, args: input }
      return undefined
    },
  })
  const host = new SourceRuleHost({ platform })
  const output = await host.evaluate({ source, stage: 'search', field: 'fixture', rule: '@js:JSON.stringify(java.openUrl("https://example.test", "text/html"))', content: '' })
  assert.equal(output.status, 'success', output.message)
  assert.deepEqual(JSON.parse(String(output.value)), { accepted: true, args: ['https://example.test', 'text/html'] })
  assert.deepEqual(calls, [{ capability: 'java.openUrl', input: ['https://example.test', 'text/html'], source: source.bookSourceUrl }])
})

test('Node SourceLock 跨执行等待、singleFlight 跳过和 tick LRU 遵循 Android 语义', async () => {
  const locks = new NodeSourceConcurrency()
  const first = await locks.acquire('singleFlight', 'fixture@same', 0, new AbortController().signal)
  const queued = locks.acquire('singleFlight', 'fixture@same', 1000, new AbortController().signal)
  locks.release(first.token)
  assert.deepEqual(await queued, { token: '', skip: true })

  const lock = await locks.acquire('lock', 'fixture@lock', 0, new AbortController().signal)
  await assert.rejects(() => locks.acquire('lock', 'fixture@lock', 5, new AbortController().signal), /等待超时/u)
  locks.release(lock.token)
  const next = await locks.acquire('lock', 'fixture@lock', 0, new AbortController().signal)
  locks.release(next.token)

  assert.equal(locks.tick('fixture@counter'), 0)
  assert.equal(locks.tick('fixture@counter'), 1)
  locks.close()
  await assert.rejects(() => locks.acquire('lock', 'fixture@closed', 0, new AbortController().signal), /已关闭/u)
})

test('Node 归档宿主通过 bsdtar 支持受预算的 7z 条目', async (context) => {
  try {
    await execFile('bsdtar', ['--version'])
  } catch {
    context.skip('bsdtar is unavailable')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'legado-7z-test-'))
  try {
    const input = join(root, 'input.txt')
    const archive = join(root, 'fixture.7z')
    await writeFile(input, '七字节测试', 'utf8')
    await execFile('bsdtar', ['--format', '7zip', '-cf', archive, '-C', root, 'input.txt'])
    const entries = await new NodeArchiveHost().extract(Uint8Array.from(await readFile(archive)), '7z')
    assert.deepEqual(entries.map((entry) => [entry.path, new TextDecoder().decode(entry.data)]), [['input.txt', '七字节测试']])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('RAR/7z 缺少外部解包器时返回可识别的能力错误', async () => {
  const host = new NodeArchiveHost({ archiveCommand: 'legado-archive-command-does-not-exist' })
  await assert.rejects(() => host.extract(new Uint8Array([1, 2, 3]), 'rar'), /__LEGADO_CAPABILITY__runtime archive\.rar requires/u)
})
