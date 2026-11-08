import assert from 'node:assert/strict'
import test from 'node:test'
import type { NetworkHost, NormalizedSource } from '@legado/source-core'
import { NodeCookieStore, createNodeSourceSession } from '../src/index.ts'

const source = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'cookie fixture',
  jsLib: '',
} as NormalizedSource

test('CookieStore map conversion preserves Android keys, insertion order, and value boundaries', () => {
  const store = new NodeCookieStore()
  const map = store.cookieToMap('3=three; 1=one; =empty; __proto__=literal; sid=a=b; sid=last; blank=; emptyNull= null ')

  assert.equal(Object.prototype.hasOwnProperty.call(map, ''), true)
  assert.equal(map[''], 'empty')
  assert.equal(Object.prototype.hasOwnProperty.call(map, '__proto__'), true)
  assert.equal(map['__proto__'], 'literal')
  assert.equal(map.sid, 'last')
  assert.equal(map.emptyNull, 'null')
  assert.equal(Object.prototype.hasOwnProperty.call(map, 'blank'), false)
  assert.equal(store.mapToCookie(map), '3=three; 1=one; =empty; __proto__=literal; sid=last; emptyNull=null')

  const whitespaceMap = store.cookieToMap('asciiKey\t= \t value \t;nbspKey\u00a0=value\u00a0;onlyBlank=\u00a0;asciiBlank=\t ;literalNull=\t null \t;feffValue=\ufeff;')
  assert.equal(whitespaceMap.asciiKey, 'value')
  assert.equal(whitespaceMap['nbspKey\u00a0'], 'value\u00a0')
  assert.equal(Object.prototype.hasOwnProperty.call(whitespaceMap, 'onlyBlank'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(whitespaceMap, 'asciiBlank'), false)
  assert.equal(whitespaceMap.literalNull, 'null')
  assert.equal(whitespaceMap.feffValue, '\ufeff')
  assert.equal(store.mapToCookie(whitespaceMap), 'asciiKey=value; nbspKey\u00a0=value\u00a0; literalNull=null; feffValue=\ufeff')
})

test('NodeCookieStore 替换保留 Android Map 合并顺序并忽略空更新', async () => {
  const store = new NodeCookieStore()
  const url = 'https://fixture.invalid/path'
  await store.set(url, 'sid=old; theme=night')
  await store.replaceCookie(url, 'sid=new; token=x')
  assert.equal(await store.get(url), 'sid=new; theme=night; token=x')
  await store.replaceCookie(url, '')
  assert.equal(await store.get(url), 'sid=new; theme=night; token=x')
})

test('书源 cookie.cookieToMap 返回可按 Android Map API 观察的有序 Map', async () => {
  const network: NetworkHost = {
    request: async (plan) => ({ url: plan.url, status: 200, headers: {}, bytes: new Uint8Array(), redirected: false }),
  }
  const session = createNodeSourceSession(source, { network })
  try {
    const result = await session.run((ports) => ports.rules.evaluate({
      source: session.source,
      stage: 'search',
      field: 'cookieMap',
      rule: '@js:var map = cookie.cookieToMap("3=three; 1=one; =empty; __proto__=literal; sid=a=b; sid=last; blank=; emptyNull= null "); JSON.stringify({keys:map.keySet().toArray(), empty:map.get(""), emptyPresent:map.containsKey(""), prototypeValue:map.get("__proto__"), sid:map.get("sid"), cookie:cookie.mapToCookie(map)})',
      content: '',
    }))

    assert.equal(result.status, 'success', result.message)
    assert.deepEqual(JSON.parse(String(result.value)), {
      keys: ['3', '1', '', '__proto__', 'sid', 'emptyNull'],
      empty: 'empty',
      emptyPresent: true,
      prototypeValue: 'literal',
      sid: 'last',
      cookie: '3=three; 1=one; =empty; __proto__=literal; sid=last; emptyNull=null',
    })
  } finally {
    session.close()
  }
})
