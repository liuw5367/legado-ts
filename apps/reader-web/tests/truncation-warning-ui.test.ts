import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const sourceRoot = resolve(import.meta.dirname, '../src')

// 仓库没有 DOM 测试环境，页面接线用源码断言守：至少保证截断字段仍被读取并渲染。
test('目录页和阅读页渲染接口返回的截断提示', async () => {
  const tocPage = await readFile(resolve(sourceRoot, 'pages/toc.tsx'), 'utf8')
  const readerPage = await readFile(resolve(sourceRoot, 'pages/reader.tsx'), 'utf8')
  assert.match(tocPage, /snapshot\.toc\.runtimeWarning/u)
  assert.match(tocPage, /setWarning\(/u)
  assert.match(tocPage, /warning\.length > 0/u)
  assert.match(readerPage, /contentResult\.content\.runtimeWarning/u)
  assert.match(readerPage, /setContentWarning\(/u)
  assert.match(readerPage, /contentWarning\.length > 0/u)
})
