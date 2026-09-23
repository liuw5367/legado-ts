import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSourceRequestUrl, splitSourceRequestUrl } from '../src/public/index.ts'

test('URL 选项后缀只在逗号后跟 JSON 对象时拆分', () => {
  assert.deepEqual(splitSourceRequestUrl('https://fixture.invalid/search?tag=a,b'), { url: 'https://fixture.invalid/search?tag=a,b' })
  assert.deepEqual(splitSourceRequestUrl('https://fixture.invalid/search?tag=a,b, {"method":"POST","body":{"key":"value"}}'), {
    url: 'https://fixture.invalid/search?tag=a,b',
    options: { method: 'POST', body: { key: 'value' } },
  })
  assert.deepEqual(splitSourceRequestUrl("/search, {'method':'POST','body':'q=it\\'s-ok'}"), {
    url: '/search',
    options: { method: 'POST', body: "q=it's-ok" },
  })
})

test('按书源字符集编码查询参数后再规范化 URL', () => {
  const gbk = (value: string) => new Uint8Array([...value].flatMap((character) => character === '中' ? [0xd6, 0xd0] : character === '文' ? [0xce, 0xc4] : [character.charCodeAt(0)]))
  assert.equal(resolveSourceRequestUrl('/search?q=中文&tag=a,b', 'https://fixture.invalid', 'gbk', gbk), 'https://fixture.invalid/search?q=%D6%D0%CE%C4&tag=a,b')
  assert.equal(resolveSourceRequestUrl('/search?q=中文', 'https://fixture.invalid', undefined), 'https://fixture.invalid/search?q=%E4%B8%AD%E6%96%87')
  assert.equal(resolveSourceRequestUrl('/search?q=中文', 'https://fixture.invalid', 'escape'), 'https://fixture.invalid/search?q=%u4E2D%u6587')
})
