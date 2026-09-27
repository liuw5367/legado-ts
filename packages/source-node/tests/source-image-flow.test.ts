import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeImage } from '../../source-core/src/index.ts'
import type { BookMetadata, NetworkHost, NormalizedSource, WorkflowPorts } from '../../source-core/src/index.ts'
import { SourceRuleHost } from '../src/source-rule-host.ts'

function source(overrides: Record<string, unknown> = {}): NormalizedSource {
  return {
    bookSourceUrl: 'https://images.test/source',
    bookSourceName: 'Image source',
    bookSourceType: 0,
    ruleContent: {},
    ...overrides,
  } as unknown as NormalizedSource
}

function book(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    sourceId: 'https://images.test/source',
    bookUrl: 'https://images.test/book/1',
    type: 777,
    rawFields: {},
    traceRef: 'image-test',
    emptyFields: [],
    fieldErrors: {},
    ...overrides,
  }
}

function ports(rules: WorkflowPorts['rules'] = new SourceRuleHost()): WorkflowPorts {
  const network: NetworkHost = { request: async () => { throw new Error('image decode must not request a download') } }
  return { network, rules }
}

test('无解密规则原样返回图片 bytes，空白封面规则不调用 JavaScript 宿主', async () => {
  let executions = 0
  const inputBytes = Uint8Array.from([0, 128, 255])
  const result = await decodeImage(ports({
    evaluate: async () => ({ status: 'success', value: '' }),
    executeImageDecodeScript: async () => {
      executions += 1
      return { status: 'success', value: new Uint8Array() }
    },
  }), {
    source: source({ coverDecodeJs: '  ' }),
    src: 'https://images.test/cover.png',
    bytes: inputBytes,
    isCover: true,
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.equal(result.value, inputBytes)
  assert.equal(executions, 0)
})

test('封面 QuickJS 收到 InputStream 风格的 result、src、书籍字段和边界字节', async () => {
  const inputBytes = Uint8Array.from([0, 1, 127, 128, 254, 255])
  const src = 'https://images.test/book/cover.bin'
  const result = await decodeImage(ports(), {
    source: source({
      coverDecodeJs: 'if (src !== "https://images.test/book/cover.bin" || book.origin !== "https://images.test/source" || book.originName !== "Image source" || book.type !== 777) throw new Error("image bindings missing"); const decoded = new Uint8Array(result.available()); for (let index = 0; index < decoded.length; index++) decoded[index] = result.read(); Uint8Array.from(decoded, value => value ^ 255)',
      ruleContent: { imageDecode: 'Uint8Array.of(22)' },
    }),
    src,
    bytes: inputBytes,
    isCover: true,
    book: book(),
  })

  assert.equal(result.status, 'success', JSON.stringify(result))
  assert.deepEqual([...result.value!], [255, 254, 128, 127, 1, 0])
})

test('正文 imageDecode 将 bytes 暴露为 Uint8Array', async () => {
  const result = await decodeImage(ports(), {
    source: source({ ruleContent: { imageDecode: 'Uint8Array.from(result, value => value ^ 255)' } }),
    src: 'https://images.test/page.png',
    bytes: Uint8Array.from([0, 128, 255]),
    isCover: false,
  })

  assert.equal(result.status, 'success')
  assert.deepEqual([...result.value!], [255, 127, 0])
})

test('封面 InputStream 兼容对象支持缓冲区读取、skip、mark 和 reset', async () => {
  const result = await decodeImage(ports(), {
    source: source({ coverDecodeJs: 'const first = result.read(); result.mark(8); const skipped = result.skip(2); result.reset(); const buffer = new Uint8Array(2); const count = result.read(buffer, 0, 2); Uint8Array.of(first, count, skipped, buffer[0], buffer[1], result.available())' }),
    src: 'https://images.test/cover.png',
    bytes: Uint8Array.from([0, 1, 127, 128, 254, 255]),
    isCover: true,
  })

  assert.equal(result.status, 'success')
  assert.deepEqual([...result.value!], [0, 2, 2, 1, 127, 3])
})

test('封面调用可显式将 InputStream 默认形态切换为 Uint8Array', async () => {
  const result = await decodeImage(ports(), {
    source: source({ coverDecodeJs: 'Uint8Array.from(result, value => value + 1)' }),
    src: 'https://images.test/cover.png',
    bytes: Uint8Array.from([1, 2]),
    isCover: true,
    resultInputKind: 'bytes',
  })

  assert.equal(result.status, 'success')
  assert.deepEqual([...result.value!], [2, 3])
})

test('封面与正文分别选择 coverDecodeJs 和 ruleContent.imageDecode', async () => {
  const sourceValue = source({ coverDecodeJs: 'Uint8Array.of(11)', ruleContent: { imageDecode: 'Uint8Array.of(22)' } })
  const cover = await decodeImage(ports(), { source: sourceValue, src: '/cover', bytes: new Uint8Array(), isCover: true })
  const inline = await decodeImage(ports(), { source: sourceValue, src: '/page', bytes: new Uint8Array(), isCover: false })

  assert.deepEqual([...cover.value!], [11])
  assert.deepEqual([...inline.value!], [22])
})

test('解密脚本错误或返回普通数组时失败，不把原始密文当作成功结果', async () => {
  for (const rule of ['throw new Error("decode failed")', '[1, 2, 3]']) {
    const bytes = Uint8Array.from([9, 8, 7])
    const result = await decodeImage(ports(), {
      source: source({ coverDecodeJs: rule }),
      src: 'https://images.test/encrypted',
      bytes,
      isCover: true,
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.value, null)
    assert.ok(result.diagnostics.some((item) => item.field === 'coverDecodeJs'))
  }
})

test('没有图片解密脚本宿主时返回 capability-missing', async () => {
  const result = await decodeImage(ports({ evaluate: async () => ({ status: 'success', value: '' }) }), {
    source: source({ coverDecodeJs: 'Uint8Array.of(1)' }),
    src: 'https://images.test/cover.png',
    bytes: new Uint8Array([9]),
    isCover: true,
  })

  assert.equal(result.status, 'capability-missing')
  assert.equal(result.value, null)
})

test('图片解密取消以 cancelled 状态返回', async () => {
  const controller = new AbortController()
  const host = new SourceRuleHost()
  const result = await decodeImage(ports({
    evaluate: (request) => host.evaluate(request),
    executeImageDecodeScript: (request) => {
      controller.abort()
      return host.executeImageDecodeScript({ ...request, signal: controller.signal })
    },
  }), {
    source: source({ coverDecodeJs: 'Uint8Array.of(1)' }),
    src: 'https://images.test/slow',
    bytes: new Uint8Array([1]),
    isCover: true,
    signal: controller.signal,
  })

  assert.equal(result.status, 'cancelled')
  assert.equal(result.value, null)
})
