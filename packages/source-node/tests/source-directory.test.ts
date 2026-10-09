import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { readSourcePath } from '../src/index.ts'

test('source directory reader follows stable recursive CLI rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-source-directory-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'root.json'), '{}', 'utf8')
    await writeFile(join(root, 'nested', 'child.JS'), 'config = {}', 'utf8')
    await writeFile(join(root, 'nested', 'ignored.txt'), '{}', 'utf8')
    await symlink(join(root, 'root.json'), join(root, 'nested', 'link.json'))
    const result = await readSourcePath(root)
    assert.deepEqual(result.inputs.map((item) => basename(item.location)), ['child.JS', 'root.json'])
    assert.deepEqual(result.diagnostics, [])
    assert.equal(await readlink(join(root, 'nested', 'link.json')), join(root, 'root.json'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('source directory reader reports missing paths and byte limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-source-directory-limit-'))
  try {
    const file = join(root, 'large.json')
    await writeFile(file, '123456789', 'utf8')
    const missing = await readSourcePath(join(root, 'missing'))
    assert.equal(missing.inputs.length, 0)
    assert.match(missing.diagnostics[0] ?? '', /书源路径不存在/u)
    const limited = await readSourcePath(file, { maxBytes: 4 })
    assert.equal(limited.inputs.length, 0)
    assert.match(limited.diagnostics[0] ?? '', /书源文件超过 4 字节/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
