import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createRequestPlan } from '@legado/source-core'
import { NodeNetworkHost } from '../src/index.ts'

async function startServer(redirectTarget?: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/set-cookie') {
      response.setHeader('Set-Cookie', 'sid=abc; Path=/')
      response.end('cookie set')
      return
    }
    if (request.url === '/echo-cookie') {
      response.end(request.headers.cookie ?? '')
      return
    }
    if (request.url === '/redirect') {
      response.statusCode = 302
      response.setHeader('Location', redirectTarget ?? '/payload')
      response.end()
      return
    }
    if (request.url === '/headers') {
      response.end(request.headers.authorization ?? '')
      return
    }
    if (request.url === '/large') {
      response.end('0123456789')
      return
    }
    response.end('payload')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  }
}

function plan(url: string, budget: Record<string, number> = {}) {
  const result = createRequestPlan({ url, budget: { ...budget, maxTotalBytes: budget.maxTotalBytes ?? 1024 } })
  assert.ok(result.plan)
  return result.plan
}

test('Node 网络宿主处理受控 HTTP、重定向、Cookie 和响应字节预算', async () => {
  const server = await startServer()
  try {
    const host = new NodeNetworkHost({ allowPrivateNetworks: true })
    const setCookie = await host.request(plan(`${server.baseUrl}/set-cookie`))
    assert.equal(new TextDecoder().decode(setCookie.bytes), 'cookie set')
    const cookie = await host.request(plan(`${server.baseUrl}/echo-cookie`))
    assert.equal(new TextDecoder().decode(cookie.bytes), 'sid=abc')

    const redirected = await host.request(plan(`${server.baseUrl}/redirect`, { maxRedirects: 1 }))
    assert.equal(redirected.redirected, true)
    assert.equal(redirected.url, `${server.baseUrl}/payload`)
    assert.equal(new TextDecoder().decode(redirected.bytes), 'payload')

    await assert.rejects(() => host.request(plan(`${server.baseUrl}/large`, { maxResponseBytes: 4 })), /response exceeds byte budget/)
  } finally {
    await server.close()
  }
})

test('Node 网络宿主默认拒绝环回地址', async () => {
  const host = new NodeNetworkHost()
  await assert.rejects(() => host.request(plan('http://127.0.0.1:1')), /private network request is not allowed/)
  await assert.rejects(() => host.request(plan('http://[::1]:1')), /private network request is not allowed/)
  await assert.rejects(() => host.request(plan('http://[::ffff:7f00:1]:1')), /private network request is not allowed/)
})

test('Node 网络宿主跨源重定向不转发认证头', async () => {
  const target = await startServer()
  const source = await startServer(`${target.baseUrl}/headers`)
  try {
    const result = createRequestPlan({ url: `${source.baseUrl}/redirect`, headers: { Authorization: 'Bearer secret' } })
    assert.ok(result.plan)
    const response = await new NodeNetworkHost({ allowPrivateNetworks: true }).request(result.plan)
    assert.equal(new TextDecoder().decode(response.bytes), '')
  } finally {
    await source.close()
    await target.close()
  }
})
