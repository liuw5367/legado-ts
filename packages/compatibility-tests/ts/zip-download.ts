import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedSource } from '../../source-core/src/index.ts'
import { createNodeSourceSession } from '../../source-node/src/source-session.ts'

export async function executeZipDownload(input: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'legado-compat-zip-'))
  const url = String(input.url)
  const finalUrl = String(input.finalUrl)
  const source: NormalizedSource = { bookSourceUrl: new URL(url).origin, bookSourceName: 'zip-fixture' }
  const requests: unknown[] = []
  const session = createNodeSourceSession(source, {
    fileRoot: root,
    network: {
      getLoginHeaders: () => ({ Authorization: String(input.authorization) }),
      request: async (plan) => {
        const transportFailed = input.kind === 'transport-failure' || plan.url !== url
        requests.push({
          method: plan.method, url: plan.url,
          authorization: Object.entries(plan.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null,
          followRedirects: plan.followRedirects, finalUrl: transportFailed ? null : finalUrl,
        })
        if (transportFailed) throw new Error('离线下载失败')
        return { status: 200, url: finalUrl, bytes: Buffer.from(String(input.archive), 'base64'), headers: {}, redirected: true }
      },
    },
  })
  try {
    const archive = input.hex === true ? Buffer.from(String(input.archive), 'base64').toString('hex') : url
    const args = `${JSON.stringify(archive)}, ${JSON.stringify(input.path)}`
    const value = input.binary === true ? `Array.from(java.getZipByteArrayContent(${args}), value => value & 255)` : `java.getZipStringContent(${args})`
    const code = input.observeScriptBytes === true
      ? `var bytes = java.getZipByteArrayContent(${args}); JSON.stringify({
          indexed: [bytes[0], bytes[1], bytes[2], bytes[3]],
          list: Array.from(bytes),
          decoded: Array.from(java.bytesToStr(bytes, "ISO-8859-1"), c => c.charCodeAt(0)),
          hex: Array.from(bytes, n => (n & 255).toString(16).padStart(2, "0")).join("")
        })`
      : `JSON.stringify(${value})`
    const result = await session.run((ports) => ports.rules.evaluate({
      source, stage: 'detail', field: 'fixture', rule: `@js:${code}`, content: '',
    }))
    return {
      text: result.status === 'success' ? JSON.parse(String(result.value)) : null,
      status: result.status, requests, remainingFiles: await readdir(root, { recursive: true }),
    }
  } finally {
    session.close()
    await rm(root, { recursive: true, force: true })
  }
}
