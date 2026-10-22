import assert from 'node:assert/strict'
import { getCiphers } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'
import test from 'node:test'
import { NodeArchiveHost, NodeCryptoHost, NodeEncodingHost, KeyedConcurrencyHost } from '../src/index.ts'

function zipEntry(name: string, data: Uint8Array, method = 0): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const compressed = method === 0 ? data : Uint8Array.from(deflateRawSync(data))
  const crc = crc32(data)
  const local = new Uint8Array(30 + nameBytes.length + compressed.length)
  const central = new Uint8Array(46 + nameBytes.length)
  const view = new DataView(local.buffer)
  view.setUint32(0, 0x04034b50, true); view.setUint16(8, 0, true); view.setUint16(18, method, true); view.setUint32(14, crc, true); view.setUint32(18, compressed.length, true); view.setUint32(22, data.length, true); view.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30); local.set(compressed, 30 + nameBytes.length)
  const centralView = new DataView(central.buffer)
  centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(8, 20, true); centralView.setUint16(10, method, true); centralView.setUint32(16, crc, true); centralView.setUint32(20, compressed.length, true); centralView.setUint32(24, data.length, true); centralView.setUint16(28, nameBytes.length, true); centralView.setUint32(42, 0, true); central.set(nameBytes, 46)
  const end = new Uint8Array(22); const endView = new DataView(end.buffer); endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, 1, true); endView.setUint16(10, 1, true); endView.setUint32(12, central.length, true); endView.setUint32(16, local.length, true)
  const result = new Uint8Array(local.length + central.length + end.length); result.set(local); result.set(central, local.length); result.set(end, local.length + central.length); return result
}

function zipStored(name: string, data: Uint8Array): Uint8Array {
  return zipEntry(name, data)
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of input) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}

test('Node 编码宿主保持字符集、二进制与 URL 边界', () => {
  const host = new NodeEncodingHost()
  const bytes = host.encode('中文', 'utf-8')
  assert.equal(host.decode(bytes, 'utf-8'), '中文')
  assert.equal(host.base64Encode(Uint8Array.from([0, 255, 3])), 'AP8D')
  assert.deepEqual(host.base64Decode('AP8D'), Uint8Array.from([0, 255, 3]))
  assert.equal(host.hexEncode(Uint8Array.from([0, 255, 3])), '00ff03')
  assert.deepEqual(host.hexDecode('00ff03'), Uint8Array.from([0, 255, 3]))
  assert.equal(host.decodeUri(host.encodeUri('https://a.test/中文?q=a b')), 'https://a.test/中文?q=a b')
  assert.throws(() => host.hexDecode('0'), /hexadecimal/)
})

test('Node 加密宿主支持摘要、HMAC 与 AES 文本往返', () => {
  const host = new NodeCryptoHost()
  assert.equal(host.digestHex('abc', 'md5'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(host.hmacHex('abc', 'key', 'sha256'), '9c196e32dc0175f86f4b1cb89289d6619de6bee699e4c378e68309ed97a1a6ab')
  assert.equal(host.digestHex('abc', 'sm3'), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
  const crypto = host.createSymmetricCrypto('AES/CBC/PKCS5Padding', new TextEncoder().encode('1234567890123456'), new Uint8Array(16))
  const encrypted = crypto.encryptText('中文')
  assert.equal(crypto.decryptText(encrypted), '中文')
})

test('Node 加密宿主按 Android 约定保留 GCM authentication tag，并报告 provider 缺口', () => {
  const host = new NodeCryptoHost()
  const key = new Uint8Array(16)
  const iv = new Uint8Array(12)
  const crypto = host.createSymmetricCrypto('AES/GCM/NoPadding', key, iv)
  const encrypted = crypto.encrypt(new Uint8Array(16))
  assert.equal(Buffer.from(encrypted).toString('hex'), '0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf')
  assert.deepEqual(crypto.decrypt(encrypted), new Uint8Array(16))
  const tampered = Uint8Array.from(encrypted)
  const lastByte = tampered.length - 1
  tampered[lastByte] = tampered[lastByte]! ^ 1
  assert.throws(() => crypto.decrypt(tampered), /auth|authenticate|bad decrypt/iu)
  if (getCiphers().includes('aes-128-ccm')) {
    const ccm = host.createSymmetricCrypto('AES/CCM/NoPadding', key, iv)
    const ccmEncrypted = ccm.encrypt(new Uint8Array(16))
    assert.equal(Buffer.from(ccmEncrypted).toString('hex'), '6ec75fb2e2b487461eddcbb8971192ba4d4fa3af0bf6d3454171306ffadd9afd')
    assert.deepEqual(ccm.decrypt(ccmEncrypted), new Uint8Array(16))
    const ccmTampered = Uint8Array.from(ccmEncrypted)
    ccmTampered[ccmTampered.length - 1] = ccmTampered[ccmTampered.length - 1]! ^ 1
    assert.throws(() => ccm.decrypt(ccmTampered), /auth|authenticate|bad decrypt/iu)
  } else {
    assert.throws(() => host.createSymmetricCrypto('AES/CCM/NoPadding', key, iv), /__LEGADO_CAPABILITY__runtime crypto\.provider/u)
  }
  const desKey = Uint8Array.from(Buffer.from('0123456789abcdef', 'hex'))
  const desIv = Uint8Array.from(Buffer.from('1234567890abcdef', 'hex'))
  if (getCiphers().includes('des-cbc') || getCiphers().includes('des-ede-cbc')) {
    const des = host.createSymmetricCrypto('DES/CBC/PKCS5Padding', desKey, desIv)
    assert.equal(Buffer.from(des.encrypt(new TextEncoder().encode('12345678'))).toString('hex'), 'c95f06a20fb4e48bd2d01d7c4b9f2f07')
  } else {
    assert.throws(() => host.createSymmetricCrypto('DES/CBC/PKCS5Padding', new TextEncoder().encode('12345678'), new Uint8Array(8)), /__LEGADO_CAPABILITY__runtime crypto\./u)
  }
  if (getCiphers().includes('sm4-ecb')) {
    const sm4Key = Uint8Array.from(Buffer.from('0123456789abcdeffedcba9876543210', 'hex'))
    const sm4 = host.createSymmetricCrypto('SM4/ECB/NoPadding', sm4Key)
    assert.equal(Buffer.from(sm4.encrypt(sm4Key)).toString('hex'), '681edf34d206965e86b3e94f536e4246')
    assert.deepEqual(sm4.decrypt(sm4.encrypt(sm4Key)), sm4Key)
  } else {
    assert.throws(() => host.createSymmetricCrypto('SM4/ECB/NoPadding', new Uint8Array(16)), /__LEGADO_CAPABILITY__runtime crypto\./u)
  }
})

test('Node 压缩宿主限制 gzip 与 zip 输出', async () => {
  const host = new NodeArchiveHost()
  const gzip = await host.extract(Uint8Array.from(gzipSync(Buffer.from('hello'))), 'gzip')
  assert.deepEqual(gzip[0]?.data, new TextEncoder().encode('hello'))
  const zipBytes = zipStored('a.txt', new TextEncoder().encode('hello'))
  const zip = await host.extract(zipBytes, 'zip')
  assert.equal(zip[0]?.path, 'a.txt')
  assert.equal(new TextDecoder().decode(zip[0]!.data), 'hello')
  const deflated = await host.extract(zipEntry('compressed.txt', new TextEncoder().encode('hello'.repeat(20)), 8), 'zip')
  assert.equal(new TextDecoder().decode(deflated[0]!.data), 'hello'.repeat(20))
  await assert.rejects(host.extract(zipStored('../escape.txt', new TextEncoder().encode('bad')), 'zip'), /path traversal/)
  await assert.rejects(host.extract(zipBytes.slice(0, -1), 'zip'), /end of central directory/)
  await assert.rejects(host.extract(Uint8Array.from(gzipSync(Buffer.from('hello'))), 'gzip', { maxEntryBytes: 2 }), /byte budget/)
  await assert.rejects(host.extract(Uint8Array.from(gzipSync(Buffer.from('a'.repeat(1000)))), 'gzip', { maxCompressionRatio: 10 }), /compression ratio/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(host.extract(zipBytes, 'zip', {}, cancelled.signal), /__LEGADO_CANCELLED__/u)
})

test('按 key 并发保持同 key 顺序并取消排队任务', async () => {
  const host = new KeyedConcurrencyHost({ maxConcurrent: 2, maxConcurrentPerKey: 1 })
  const events: string[] = []
  const first = host.run('source', async () => { events.push('first:start'); await new Promise((resolve) => setTimeout(resolve, 5)); events.push('first:end'); return 1 })
  const controller = new AbortController()
  const cancelled = host.run('source', async () => { events.push('cancelled:start'); return 2 }, controller.signal)
  const cancelledResult = assert.rejects(cancelled, { name: 'AbortError' })
  controller.abort()
  const second = host.run('source', async () => { events.push('second:start'); return 3 })
  assert.equal(await first, 1)
  await cancelledResult
  assert.equal(await second, 3)
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
})
