import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSourceManagementOrder, groupSourcesByDomain, selectOneSourcePerDomain, sourceDomainInfo } from '../shared/source-domain.ts'
import { formatSourceRuleDateTime } from '../src/lib/time-format.ts'

test('source domain groups ignore scheme, path, query, fragment, and default ports', () => {
  const sources = [
    { sourceId: 'https://example.com:443/one?x=1#top', name: '同域一' },
    { sourceId: 'http://EXAMPLE.com:80/two', name: '同域二' },
    { sourceId: 'https://www.example.com/one', name: '子域' },
    { sourceId: 'https://example.com:8443/one', name: '非默认端口' },
  ]

  const groups = groupSourcesByDomain(sources)

  assert.deepEqual(groups.map((group) => [group.domain, group.versions.map(({ source }) => source.name)]), [
    ['example.com', ['同域二', '同域一']],
    ['example.com:8443', ['非默认端口']],
    ['www.example.com', ['子域']],
  ])
})

test('invalid source IDs use their full identity as an independent domain', () => {
  assert.deepEqual(sourceDomainInfo('not a URL'), { key: 'source:not a URL', domain: 'not a URL' })
  assert.notEqual(sourceDomainInfo('not a URL').key, sourceDomainInfo('not another URL').key)
})

test('same-name versions get sourceId-stable numbers while display order uses rule time', () => {
  const sources = [
    { sourceId: 'https://same.example/z', name: '  同名  ', lastUpdateTime: 100 },
    { sourceId: 'https://same.example/a', name: '同名', lastUpdateTime: 200 },
    { sourceId: 'https://same.example/other', name: '另一个', lastUpdateTime: 50 },
    { sourceId: 'https://same.example/no-time', name: '无时间' },
  ]

  const group = groupSourcesByDomain(sources)[0]

  assert.deepEqual(group?.versions.map(({ source, displayName }) => [source.sourceId, displayName]), [
    ['https://same.example/a', '同名 #1'],
    ['https://same.example/z', '同名 #2'],
    ['https://same.example/other', '另一个'],
    ['https://same.example/no-time', '无时间'],
  ])
})

test('duplicate rows for the same sourceId do not look like separate implementations', () => {
  const duplicate = { sourceId: 'https://same.example/source', name: '同名' }
  const [group] = groupSourcesByDomain([duplicate, { ...duplicate }])
  assert.deepEqual(group?.versions.map(({ displayName }) => displayName), ['同名', '同名'])
})

test('legacy enabled versions resolve by management order, independently of rule recency', () => {
  const sources = [
    { sourceId: 'https://same.example/newer', customOrder: 4, lastUpdateTime: 200 },
    { sourceId: 'https://same.example/selected', customOrder: 1, lastUpdateTime: 100 },
    { sourceId: 'https://other.example/one', customOrder: 2 },
  ]

  assert.deepEqual(selectOneSourcePerDomain(sources, compareSourceManagementOrder).map((source) => source.sourceId), [
    'https://same.example/selected',
    'https://other.example/one',
  ])
})

test('source rule timestamps display in Shanghai time and missing or invalid values stay unknown', () => {
  assert.equal(formatSourceRuleDateTime(Date.UTC(2026, 0, 2, 3, 4, 5)), '2026-01-02 11:04:05')
  assert.equal(formatSourceRuleDateTime(undefined), '未知')
  assert.equal(formatSourceRuleDateTime(Number.NaN), '未知')
  assert.equal(formatSourceRuleDateTime(9e99), '未知')
})
