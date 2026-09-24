import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedSource, WorkflowPorts } from '../src/index.ts'
import { expandUrl } from '../src/workflows/helpers.ts'

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
    '/page/<1,2,3><js>return result</js>@result?q={{keyword}}',
    { page: '2', keyword: '中文' },
    { page: 2, keyword: '中文' },
  )
  assert.equal(result.url, '/page/2-script?q=中文')
  assert.deepEqual(seen, [{ rule: '@js:return result', content: '/page/<1,2,3>' }])
})

test('URL 页码数组超出已列页数后继续使用最后一项', async () => {
  const { ports: workflow } = ports()
  const result = await expandUrl(workflow, source, 'search', '/search?page=<1,2,3>', { page: '5' }, { page: 5 })
  assert.equal(result.url, '/search?page=3')
})
