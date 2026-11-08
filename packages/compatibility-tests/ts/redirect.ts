import { createServer, type Server } from 'node:http'
import { createRequestPlan } from '../../source-core/src/index.ts'
import { NodeNetworkHost } from '../../source-node/src/http.ts'
import { FlowFixtureError } from './book-flow.ts'

export async function executeRedirect(input: Record<string, unknown>) {
  const requests: unknown[] = []
  const servers: Server[] = []
  async function listen(redirect?: string): Promise<string> {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({
        path: request.url, host: request.headers.host?.split(':')[0], method: request.method, body: Buffer.concat(chunks).toString('utf8'),
        userAgent: request.headers['user-agent'] ?? null,
        authorization: request.headers.authorization ?? null,
        cookie: request.headers.cookie ?? null, contentType: request.headers['content-type'] ?? null,
      })
      if (request.url === '/start' && redirect !== undefined) response.writeHead(Number(input.status), input.missingLocation === true ? {} : { Location: redirect })
      else response.writeHead(200)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error) => reject(new FlowFixtureError(`无法监听重定向夹具: ${error.message}`)))
      server.listen(0, '127.0.0.1', resolve)
    })
    servers.push(server)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new FlowFixtureError('缺少环回夹具地址')
    return `http://127.0.0.1:${address.port}`
  }
  try {
    const target = input.crossOrigin === true ? (await listen()).replace('127.0.0.1', 'localhost') : ''
    const origin = await listen(`${target}/target`)
    const request = createRequestPlan({
      url: `${origin}/start`, baseUrl: origin, method: 'POST', body: 'fixture body',
      headers: {
        'User-Agent': 'fixture-redirect', Authorization: 'Bearer fixture', Cookie: 'session=fixture',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    })
    if (!request.plan) throw new Error(request.error?.message ?? '重定向请求计划无效')
    const result = await new NodeNetworkHost({ allowPrivateNetworks: true }).request(request.plan)
    return { status: result.status, finalPath: new URL(result.url).pathname, requests }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })))
  }
}
