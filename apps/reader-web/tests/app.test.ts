import test from 'node:test'
import assert from 'node:assert/strict'
import app from '../server/app.ts'
import { safeNext } from '../src/lib/auth.ts'

test('health endpoint is public', async () => {
  const response = await app.request('http://localhost/api/health')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test('SPA entrypoint is available when Vercel static files are not in the checkout snapshot', async () => {
  const response = await app.request('http://localhost/')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type')?.startsWith('text/html'), true)
  assert.match(await response.text(), /<title>Legado Reader<\/title>/u)
})

test('SPA deep links fall back to the entrypoint without intercepting API 404s', async () => {
  const page = await app.request('http://localhost/account/settings')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id="root"><main class="boot-loading">/u)

  const api = await app.request('http://localhost/api/unknown')
  assert.equal(api.status, 404)
  assert.equal((await api.json()).error.code, 'not-found')
})

test('me endpoint rejects missing auth without reading user data', async () => {
  const response = await app.request('http://localhost/api/me')
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: { code: 'unauthenticated', message: '需要登录' } })
})

test('book details, source summaries, and review endpoints reject unauthenticated requests', async () => {
  for (const path of [
    '/api/books/00000000-0000-0000-0000-000000000001/details',
    '/api/books/00000000-0000-0000-0000-000000000001/review/summary?editionKey=edition&chapterId=chapter',
    '/api/books/00000000-0000-0000-0000-000000000001/review/detail?editionKey=edition&chapterId=chapter&paragraphIndex=1',
    '/api/books/00000000-0000-0000-0000-000000000001/review/replies?editionKey=edition&chapterId=chapter&paragraphIndex=1&reviewId=review',
    '/api/source-management?all=true',
  ]) {
    const response = await app.request('http://localhost' + path)
    assert.equal(response.status, 401)
  }
})

test('all discovery endpoints reject unauthenticated requests', async () => {
  for (const [method, path] of [['GET', '/api/discovery/sources'], ['GET', '/api/discovery/categories?sourceId=other-user'], ['POST', '/api/discovery/page'], ['POST', '/api/discovery/control'], ['POST', '/api/discovery/books']] as const) {
    const response = await app.request('http://localhost' + path, { method })
    assert.equal(response.status, 401)
  }
})

test('unknown api endpoint returns json 404', async () => {
  const response = await app.request('http://localhost/api/unknown')
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true)
})

test('callback navigation only accepts local paths', () => {
  assert.equal(safeNext('/reset-password'), '/reset-password')
  assert.equal(safeNext('//attacker.example'), '/')
  assert.equal(safeNext(null), '/')
})
