import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptRuntimeState, encryptRuntimeState, MAX_RUNTIME_STATE_BYTES, normalizeSnapshot } from '../server/db/runtime-state-crypto.ts'

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

test('runtime state encryption rejects oversized source state', () => {
  assert.throws(() => encryptRuntimeState({ variables: { oversized: 'x'.repeat(MAX_RUNTIME_STATE_BYTES) } }, secret), /超过大小限制/)
})
