import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptRuntimeState, encryptRuntimeState, MAX_RUNTIME_STATE_BYTES, normalizeSnapshot, sourceFileRoot } from '../server/db/runtime-state-crypto.ts'

const secret = 'test-runtime-state-secret-with-enough-length'

test('runtime state encryption round-trips cookies and source variables without plaintext', () => {
  const snapshot = { cookies: '{"cookies":[{"key":"sid"}]}', variables: { token: 'secret-value' } }
  const encrypted = encryptRuntimeState(snapshot, secret)
  assert.equal(encrypted.includes('secret-value'), false)
  assert.deepEqual(decryptRuntimeState(encrypted, secret), snapshot)
})

test('runtime state encryption rejects a wrong key and malformed payload', () => {
  const encrypted = encryptRuntimeState({ variables: { token: 'secret-value' } }, secret)
  assert.throws(() => decryptRuntimeState(encrypted, 'another-runtime-state-secret-with-enough-length'), /书源运行状态解密失败/)
  assert.throws(() => decryptRuntimeState('v1.invalid', secret), /书源运行状态解密失败/)
})

test('runtime state normalization accepts only serializable string variables', () => {
  assert.deepEqual(normalizeSnapshot({ variables: { token: 'value' }, cache: { key: { value: 'cached', expiresAt: 10 } } }), { variables: { token: 'value' }, cache: { key: { value: 'cached', expiresAt: 10 } } })
  assert.throws(() => normalizeSnapshot({ variables: { token: 1 } }), /invalid variable/)
})

test('runtime state preserves the Node source namespace and discovery generation', () => {
  const snapshot = {
    nodeRuntime: {
      version: 1 as const,
      sourceValues: { 'https://source.invalid': { token: 'value' } },
      loginHeaders: { 'https://source.invalid': '{"Authorization":"Bearer saved"}' },
      cache: { values: { key: { value: 'cached', expiresAt: 10 } } },
    },
    discovery: { version: 1 as const, fingerprint: 'fp', generation: 3, categories: [] },
  }
  assert.deepEqual(decryptRuntimeState(encryptRuntimeState(snapshot, secret), secret), snapshot)
  assert.throws(() => normalizeSnapshot({ nodeRuntime: { version: 2 } }), /invalid node runtime version/)
})

test('runtime state encryption rejects oversized source state', () => {
  assert.throws(() => encryptRuntimeState({ variables: { oversized: 'x'.repeat(MAX_RUNTIME_STATE_BYTES) } }, secret), /超过大小限制/)
})

test('runtime state encryption accepts 1024 KiB and rejects one extra byte', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ variables: { value: '' } }), 'utf8')
  const snapshot = { variables: { value: 'x'.repeat(1024 * 1024 - overhead) } }
  assert.deepEqual(decryptRuntimeState(encryptRuntimeState(snapshot, secret), secret), snapshot)
  assert.throws(() => encryptRuntimeState({ variables: { value: `${snapshot.variables.value}x` } }, secret), /超过大小限制/)
})

test('source file roots are deterministic but isolated by user, source, fingerprint and deployment key', () => {
  const previousRoot = process.env.SOURCE_FILE_ROOT
  const previousKey = process.env.SOURCE_RUNTIME_STATE_KEY
  try {
    process.env.SOURCE_FILE_ROOT = '/private/tmp/legado-source-root'
    process.env.SOURCE_RUNTIME_STATE_KEY = secret
    const first = sourceFileRoot('user-a', 'https://source.example/a', 'fingerprint-a')
    assert.equal(first, sourceFileRoot('user-a', 'https://source.example/a', 'fingerprint-a'))
    assert.equal(first.startsWith('/private/tmp/legado-source-root/'), true)
    assert.equal(first.includes('user-a'), false)
    assert.equal(first.includes('source.example'), false)
    assert.notEqual(first, sourceFileRoot('user-b', 'https://source.example/a', 'fingerprint-a'))
    assert.notEqual(first, sourceFileRoot('user-a', 'https://source.example/b', 'fingerprint-a'))
    assert.notEqual(first, sourceFileRoot('user-a', 'https://source.example/a', 'fingerprint-b'))
    process.env.SOURCE_RUNTIME_STATE_KEY = `${secret}-rotated`
    assert.notEqual(first, sourceFileRoot('user-a', 'https://source.example/a', 'fingerprint-a'))
  } finally {
    if (previousRoot === undefined) delete process.env.SOURCE_FILE_ROOT
    else process.env.SOURCE_FILE_ROOT = previousRoot
    if (previousKey === undefined) delete process.env.SOURCE_RUNTIME_STATE_KEY
    else process.env.SOURCE_RUNTIME_STATE_KEY = previousKey
  }
})
