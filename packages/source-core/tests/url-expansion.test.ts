import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSource, WorkflowPorts } from '../src/index.ts'
import { expandUrl } from '../src/workflows/helpers.ts'
import { internalChapterScopeBinding } from '../src/workflows/types.ts'

const source = { bookSourceUrl: 'https://fixture.invalid' } as NormalizedSource

function ports(): { ports: WorkflowPorts; seen: Array<{ rule: string; content: unknown }> } {
  const seen: Array<{ rule: string; content: unknown }> = []
  const value: WorkflowPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) },
    rules: {
      evaluate: async ({ rule, content }) => {
        seen.push({ rule, content })
        return { status: 'success', value: `${String(content)}-script` }
      },
    },
  }
  return { ports: value, seen }
}

test('URL 展开支持 Android 的页码数组、嵌入脚本与 @result', async () => {
  const { ports: workflow, seen } = ports()
  const result = await expandUrl(
    workflow,
    source,
    'search',
    '/page/<1,2,3><js>result</js>@result?q={{keyword}}',
    { page: '2', keyword: '中文' },
    { page: 2, keyword: '中文' },
  )
  assert.equal(result.url, '/page/2-script?q=中文')
  assert.deepEqual(seen, [{ rule: '@js:result', content: '/page/<1,2,3>' }])
})

test('URL 页码数组超出已列页数后继续使用最后一项', async () => {
  const { ports: workflow } = ports()
  const result = await expandUrl(workflow, source, 'search', '/search?page=<1,2,3>', { page: '5' }, { page: 5 })
  assert.equal(result.url, '/search?page=3')
})

test('@js 在 {{}} 前执行，result 保留此前 URL 原文', async () => {
  const { ports: workflow, seen } = ports()
  const result = await expandUrl(workflow, source, 'search', '/search?q={{keyword}}@js:result', { keyword: '中文' }, { keyword: '中文' })
  assert.equal(seen[0]?.content, '/search?q={{keyword}}')
  assert.equal(result.url, '/search?q=中文-script')
})

test('请求 URL 内联脚本只接收 book 与隐藏章节变量作用域', async () => {
  const seen: Array<Record<string, unknown> | undefined> = []
  const workflow: WorkflowPorts = {
    network: { request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }) },
    rules: {
      evaluate: async ({ bindings }) => {
        seen.push(bindings as Record<string, unknown> | undefined)
        return { status: 'success', value: '/chapter/1' }
      },
    },
  }
  const book = { name: '上下文书' }
  const chapter = { title: '第一章', variable: '{"token":"chapter"}' }
  const result = await expandUrl(workflow, source, 'detail', '/chapter/<js>book.name</js>', {}, {
    book,
    [internalChapterScopeBinding]: chapter,
  })
  assert.equal(result.url, '/chapter/1')
  assert.equal(Object.hasOwn(seen[0] ?? {}, 'chapter'), false)
  assert.equal((seen[0] ?? {}).book, book)
  assert.equal((seen[0] ?? {})[internalChapterScopeBinding], chapter)
})
