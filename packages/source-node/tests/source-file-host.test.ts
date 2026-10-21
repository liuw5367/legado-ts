import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { NetworkHost, NormalizedSource } from '@legado/source-core'
import { NodeCharsetCodec } from '../src/charset.ts'
import { NodeSourceFileHost } from '../src/source-file-host.ts'

const source = { bookSourceUrl: 'https://fixture.invalid', bookSourceName: 'fixture' } as NormalizedSource

test('Node 文件宿主限制相对路径并支持下载、读取和删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-file-test-'))
  try {
    const network: NetworkHost = { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('远程脚本'), redirected: false }) }
    const host = new NodeSourceFileHost({ root, network })
    const signal = new AbortController().signal
    const downloaded = await host.execute('downloadFile', { url: 'https://fixture.invalid/a.txt' }, signal, source)
    assert.equal(downloaded, '/2e6fe6ad10514e47.txt')
    assert.equal(await host.execute('readTxtFile', { path: downloaded }, signal, source), '远程脚本')
    assert.equal((await host.execute('getFile', { path: downloaded }, signal, source) as { exists: boolean }).exists, true)
    const typed = await host.execute('downloadFile', { url: 'https://fixture.invalid/no-extension, {"type":"js"}' }, signal, source)
    assert.match(String(typed), /^\/[0-9a-f]{16}\.js$/u)
    assert.equal(await host.execute('deleteFile', { path: downloaded }, signal, source), true)
    assert.equal(await host.execute('readFile', { path: downloaded }, signal, source), null)
    await assert.rejects(() => host.execute('readFile', { path: '../outside' }, signal, source), /非法路径/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Node 文件宿主提供 Android File 的元数据和 listFiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-file-list-test-'))
  try {
    const host = new NodeSourceFileHost({ root, network: { request: async () => ({ url: 'https://fixture.invalid', status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) } })
    const signal = new AbortController().signal
    await writeFile(join(root, 'one.txt'), 'one', 'utf8')
    await writeFile(join(root, 'two.txt'), 'two', 'utf8')
    const files = await host.execute('listFiles', { path: '' }, signal, source) as Array<{ name: string; length: number; lastModified: number; isFile: boolean }>
    assert.deepEqual(files.map((item) => item.name).sort(), ['one.txt', 'two.txt'])
    assert.ok(files.every((item) => item.isFile && item.length === 3 && item.lastModified > 0))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('Node 文件宿主的缓存 API 重复命中时不重复请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-cache-test-'))
  let calls = 0
  try {
    const network: NetworkHost = { request: async (plan) => { calls += 1; return { url: plan.url, status: 200, headers: {}, bytes: new TextEncoder().encode('cache'), redirected: false } } }
    const host = new NodeSourceFileHost({ root, network })
    const signal = new AbortController().signal
    assert.equal(await host.execute('cacheFile', { url: 'https://fixture.invalid/a.js' }, signal, source), 'cache')
    assert.equal(await host.execute('cacheFile', { url: 'https://fixture.invalid/a.js' }, signal, source), 'cache')
    assert.equal(calls, 1)
    assert.match(String(await readFile(join(root, '888a5ce93739a872.js'))), /cache/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Node 文件宿主在重建操作宿主后仍保留 cacheFile TTL，并自动探测文本编码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-cache-ttl-test-'))
  let calls = 0
  const text = '这是一本中文小说的章节内容。主人公走进书房，看到一本古老的书，封面上写着神秘的文字。'.repeat(20)
  try {
    const encoding = new NodeCharsetCodec()
    const network: NetworkHost = { request: async (plan) => { calls += 1; return { url: plan.url, status: 200, headers: {}, bytes: encoding.encode(text, 'gbk'), redirected: false } } }
    const first = new NodeSourceFileHost({ root, network })
    const second = new NodeSourceFileHost({ root, network })
    const signal = new AbortController().signal
    assert.equal(await first.execute('cacheFile', { url: 'https://fixture.invalid/ttl.txt', saveTime: 60 }, signal, source), text)
    assert.equal(await second.execute('cacheFile', { url: 'https://fixture.invalid/ttl.txt', saveTime: 60 }, signal, source), text)
    assert.equal(calls, 1)
    const metadata = (await readdir(join(root, '.legado-meta'))).find((name) => name.endsWith('.json'))
    assert.ok(metadata)
    await writeFile(join(root, '.legado-meta', metadata), JSON.stringify({ expiresAt: 1 }), 'utf8')
    const third = new NodeSourceFileHost({ root, network })
    assert.equal(await third.execute('cacheFile', { url: 'https://fixture.invalid/ttl.txt', saveTime: 60 }, signal, source), text)
    assert.equal(calls, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Node 文件宿主的空目录路径遵循 Android 语义且不会删除缓存根目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-empty-folder-test-'))
  try {
    const host = new NodeSourceFileHost({ root, network: { request: async () => ({ url: 'https://fixture.invalid', status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) } })
    const signal = new AbortController().signal
    await writeFile(join(root, 'keep.txt'), 'keep', 'utf8')
    assert.equal(await host.execute('getTxtInFolder', { path: '' }, signal, source), '')
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
