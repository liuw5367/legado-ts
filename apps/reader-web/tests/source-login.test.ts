import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { importSources } from '@legado/source-core'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { compareImportCandidates } from '../server/runtime/source-comparison.ts'
import { getSourceLoginUi, submitSourceLogin } from '../server/runtime/source-login.ts'

process.env.SOURCE_RUNTIME_STATE_KEY = 'source-login-tests-runtime-state-key-32-bytes'

async function setup(extra: Record<string, unknown>) {
  const repository = new MemoryReaderRepository()
  const raw = { bookSourceUrl: 'https://login.fixture.invalid', bookSourceName: '登录测试源', bookSourceType: 0, searchUrl: 'https://login.fixture.invalid/search?q={{key}}', ...extra }
  const imported = await importSources({ kind: 'text', text: JSON.stringify(raw) })
  const candidates = compareImportCandidates(imported, new Map())
  const previewId = randomUUID()
  await repository.saveImportPreview('user-a', { previewId, expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates, writableCount: candidates.length }, raw.bookSourceUrl)
  await repository.commitImportPreview('user-a', previewId, candidates.map((item) => item.id))
  return { repository, source: (await repository.listAllSourcesForUser('user-a'))[0]! }
}

test('Web 登录 API 复用静态 RowUi 默认值并保存提交后的登录信息', async () => {
  const { repository, source } = await setup({
    loginUi: JSON.stringify([{ name: 'user', type: 'text', default: 'guest' }, { name: 'password', type: 'password' }]),
    loginUrl: '@js:function login(){ source.putLoginHeader(JSON.stringify({Authorization: "Bearer " + source.getLoginInfoMap().user})); }',
  })
  assert.equal(typeof source.normalizedSource.loginUi, 'string')
  const ui = await getSourceLoginUi(repository, 'user-a', source.sourceId, source.fingerprint)
  assert.equal(ui.dynamic, false)
  assert.deepEqual(ui.values, { user: 'guest' })
  const submitted = await submitSourceLogin(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, form: { user: 'alice', password: 'secret' } })
  assert.deepEqual(submitted.values, { user: 'alice' })
  assert.deepEqual((await getSourceLoginUi(repository, 'user-a', source.sourceId, source.fingerprint)).values, { user: 'alice' })
})

test('Web 登录 API 执行静态 RowUi action 并保留当前表单 result', async () => {
  const { repository, source } = await setup({
    loginUi: JSON.stringify([{ name: 'user', type: 'text' }, { name: 'refresh', type: 'button', action: 'java.copyText(result.user); JSON.stringify({ refreshed: result.user })' }]),
    loginUrl: '@js:function login(){}',
  })
  const submitted = await submitSourceLogin(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, action: 'java.copyText(result.user); JSON.stringify({ refreshed: result.user })', form: { user: 'alice' } })
  assert.deepEqual(submitted.result, { refreshed: 'alice' })
  assert.deepEqual(submitted.values, { user: '' })
  assert.deepEqual(submitted.actions, [{ action: 'copyText' }])
})

test('Web 登录 API 支持动态 loginUi/loginAction v2 并保留 action 返回值', async () => {
  const { repository, source } = await setup({
    loginUi: JSON.stringify({ version: 2 }),
    loginUrl: '@js:function loginUi(state){ java.upLoginData({step: "form"}); if (state.step === "done") return JSON.stringify({rows: [{name: "完成", type: "label"}]}); return JSON.stringify({rows: [{key: "user", name: "账号", type: "text", default: state.user || "guest"}, {key: "password", name: "密码", type: "password"}, {name: "submit", type: "button", action: "submit"}]}); } function loginAction(action, state, form){ java.reLoginView(true); java.copyText(form.password); java.searchBook(form.user); return JSON.stringify({state: {step: "done"}, login: {user: form.user, password: form.password}, action: action, user: form.user}); }',
  })
  assert.equal(typeof source.normalizedSource.loginUi, 'string')
  const ui = await getSourceLoginUi(repository, 'user-a', source.sourceId, source.fingerprint)
  assert.equal(ui.dynamic, true)
  assert.equal(ui.fields[0]?.key, 'user')
  assert.deepEqual(ui.actions, [{ action: 'upUiData' }])
  assert.deepEqual(ui.state, {})
  const submitted = await submitSourceLogin(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, action: 'submit', state: { user: 'guest' }, form: { user: 'alice', password: 'secret' } })
  assert.deepEqual(submitted.result, { state: { step: 'done' }, login: { user: 'alice', password: '[redacted]' }, action: 'submit', user: 'alice' })
  assert.deepEqual(submitted.values, { user: 'alice' })
  assert.deepEqual(submitted.actions, [{ action: 'reUiView' }, { action: 'copyText' }, { action: 'searchBook' }, { action: 'upUiData' }])
  assert.deepEqual(submitted.state, { step: 'done' })
  assert.deepEqual(submitted.fields, [{ name: '完成', type: 'label' }])
})

test('Web 登录 action 拒绝旧书源版本', async () => {
  const { repository, source } = await setup({ loginUi: JSON.stringify([{ name: 'user', type: 'text' }]) })
  await assert.rejects(submitSourceLogin(repository, 'user-a', { sourceId: source.sourceId, fingerprint: 'stale', form: { user: 'alice' } }), /书源已更新/u)
})

test('Web 登录 action 对敏感错误字段脱敏', async () => {
  const { repository, source } = await setup({
    loginUi: JSON.stringify({ version: 2 }),
    loginUrl: '@js:function loginUi(){ return JSON.stringify({rows: [{key: "password", name: "密码", type: "password"}]}); } function loginAction(){ return JSON.stringify({error: {password: "secret-value", user: "账号无效"}}); }',
  })
  const result = await submitSourceLogin(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, action: 'submit', form: { password: 'secret' } })
  assert.deepEqual(result.errors, { password: '[redacted]', user: '账号无效' })
})

test('Web 登录 action 对常见凭据键和嵌套值脱敏', async () => {
  const { repository, source } = await setup({
    loginUi: JSON.stringify({ version: 2 }),
    loginUrl: '@js:function loginUi(){ return JSON.stringify({rows: [{key: "pwd", name: "密码", type: "password"}]}); } function loginAction(){ return JSON.stringify({pwd: "secret", apiKey: "key", nested: {otp: "123456", user: "账号"}}); }',
  })
  const result = await submitSourceLogin(repository, 'user-a', { sourceId: source.sourceId, fingerprint: source.fingerprint, action: 'submit', form: { pwd: 'secret' } })
  assert.deepEqual(result.result, { pwd: '[redacted]', apiKey: '[redacted]', nested: { otp: '[redacted]', user: '账号' } })
})
