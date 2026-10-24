import { IMPORT_FILE_MAX_BYTES } from '../../shared/source-import-limits.ts'
import { randomUUID } from 'node:crypto'
import { importSources, createRequestPlan, type ImportReader } from '@legado/source-core'
import { NodeCookieStore, NodeNetworkHost } from '@legado/source-node'
import type { ImportPreview, ImportPreviewCandidate, ImportPreviewSummary, ImportPreviewSummaryCandidate, SourceActionItem } from '../../shared/source-management.ts'
import type { ReaderRepository } from '../db/repository.ts'
import { SourceManagementError } from '../db/repository.ts'
import { compareImportCandidates } from './source-comparison.ts'

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_CANDIDATES = 1000
const MAX_SOURCE_URLS = 32
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024
const MAX_PREVIEW_TIME_MS = 45_000
const PREVIEW_TTL_MS = 15 * 60 * 1000

export { SourceManagementError }

export async function createImportPreview(repository: ReaderRepository, userId: string, sourceUrl: string, parentSignal?: AbortSignal, jsonText?: string): Promise<ImportPreview> {
  const url = validateImportUrl(sourceUrl)
  if (jsonText !== undefined) {
    if (new TextEncoder().encode(jsonText).byteLength > IMPORT_FILE_MAX_BYTES) throw new SourceManagementError('preview-invalid', 'JSON 文件不能超过 3 MiB')
    if (jsonText.trim().length === 0) throw new SourceManagementError('preview-invalid', 'JSON 文件内容不能为空')
    try { JSON.parse(jsonText) } catch { throw new SourceManagementError('preview-invalid', '文件不是有效的 JSON，请检查文件内容与 UTF-8 编码') }
  }
  const readFailures = new Map<string, string>()
  const reader = createImportReader(readFailures)
  const origins = new Map<string, string>()
  const timeoutSignal = AbortSignal.timeout(MAX_PREVIEW_TIME_MS)
  const signal = parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal])
  const candidates = await importSources(jsonText === undefined ? { kind: 'url', uri: url, origin: { kind: 'remote-url', location: url } } : { kind: 'text', text: jsonText, origin: { kind: 'remote-url', location: url } }, {
    // 本地文件只解析已上传内容，不能根据 sourceUrls 再发起远程下载。
    ...(jsonText === undefined ? { reader } : {}),
    onCandidateOrigin: (candidateId, location) => { origins.set(candidateId, location) },
    signal,
    limits: { maxCandidates: MAX_CANDIDATES, maxBytes: MAX_RESPONSE_BYTES, maxSourceUrls: MAX_SOURCE_URLS },
  })
  // core 将读取异常统一转换为 reader-failed；在 Web 边界补回脱敏诊断，不暴露原始异常或私有 URL。
  for (const candidate of candidates) {
    if (candidate.error?.code !== 'reader-failed') continue
    const message = readFailures.get(origins.get(candidate.id) ?? url)
    if (message === undefined) continue
    candidate.error.message = message
    for (const diagnostic of candidate.diagnostics) if (diagnostic.code === 'reader-failed') diagnostic.message = message
  }
  const states = await repository.listSourceStatesForUser(userId)
  const localById = new Map(states.map((state) => [state.source.sourceId, state]))
  const previewCandidates = compareImportCandidates(candidates, localById)
  for (const candidate of previewCandidates) { const origin = origins.get(candidate.id); if (origin) candidate.originLocation = origin }
  const previewBytes = new TextEncoder().encode(JSON.stringify(previewCandidates)).byteLength
  if (previewBytes > MAX_PREVIEW_BYTES) throw new SourceManagementError('preview-invalid', '导入预览超过大小限制，请拆分书源后重试')
  const preview: ImportPreview = { previewId: randomUUID(), expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), candidates: previewCandidates, writableCount: previewCandidates.filter((candidate) => candidate.disposition !== undefined).length }
  await repository.saveImportPreview(userId, preview, url)
  return preview
}

export function publicImportPreview(preview: ImportPreview): ImportPreviewSummary {
  const candidates: ImportPreviewSummaryCandidate[] = preview.candidates.map((candidate) => ({ id: candidate.id, sourceId: candidate.sourceId, name: candidate.name, ...(candidate.group === undefined ? {} : { group: candidate.group }), ...(candidate.disposition === undefined ? {} : { disposition: candidate.disposition }), ...(candidate.skippedReason === undefined ? {} : { skippedReason: candidate.skippedReason }), reason: candidate.reason, ...(candidate.lastUpdateTime === undefined ? {} : { lastUpdateTime: candidate.lastUpdateTime }), ...(candidate.localLastUpdateTime === undefined ? {} : { localLastUpdateTime: candidate.localLastUpdateTime }) }))
  return { previewId: preview.previewId, expiresAt: preview.expiresAt, candidates, writableCount: preview.writableCount }
}

export function confirmImport(repository: ReaderRepository, userId: string, previewId: string, candidateIds: string[]): Promise<import('../../shared/source-management.ts').ImportConfirmResult> {
  return repository.commitImportPreview(userId, previewId, [...new Set(candidateIds)])
}

export function listSourceActions(repository: ReaderRepository, userId: string, action: 'enable' | 'disable' | 'delete', items: SourceActionItem[]): Promise<{ affected: number }> {
  return repository.applySourceActions(userId, action, items)
}

function validateImportUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new SourceManagementError('preview-invalid', '导入地址不是有效 URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SourceManagementError('preview-invalid', '导入地址只允许 HTTP(S) 协议')
  if (url.username.length > 0 || url.password.length > 0) throw new SourceManagementError('preview-invalid', '导入地址不能包含账号或密码')
  return url.toString()
}

function createImportReader(failures: Map<string, string>): ImportReader {
  const cookieStore = new NodeCookieStore()
  const network = new NodeNetworkHost({ cookieStore })
  let totalBytes = 0
  return {
    async read(request) {
      const started = Date.now()
      try {
        const planResult = createRequestPlan({
          url: request.uri,
          method: 'GET',
          responseType: 'bytes',
          followRedirects: true,
          execution: { cookieJar: false },
          // 每次跳转也占用请求预算，5次跳转需要包含首个请求的6次预算。
          budget: { timeoutMs: 15_000, maxRequests: 6, maxPages: 1, maxResponseBytes: Math.min(request.maxBytes, MAX_RESPONSE_BYTES), maxTotalBytes: MAX_TOTAL_BYTES, maxRedirects: 5, ...(request.signal === undefined ? {} : { signal: request.signal }) },
        })
        if (planResult.plan === undefined) throw new Error(planResult.error?.message ?? '导入地址无效')
        const response = await network.request(planResult.plan)
        if (response.status < 200 || response.status >= 300) throw new Error(`导入链接返回 HTTP ${response.status}`)
        totalBytes += response.bytes.byteLength
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error('导入内容超过总字节限制')
        return { text: new TextDecoder().decode(response.bytes), location: response.url }
      } catch (error) {
        const failure = importReadFailure(error)
        const diagnosticId = randomUUID()
        const message = `导入下载失败：${failure.message}（${failure.code}，诊断编号 ${diagnosticId}）`
        failures.set(request.uri, message)
        console.error('书源导入下载失败', { diagnosticId, host: URL.canParse(request.uri) ? new URL(request.uri).hostname : 'invalid-url', code: failure.code, elapsedMs: Date.now() - started })
        throw error
      }
    },
  }
}

export function previewWritableCandidates(preview: ImportPreview): ImportPreviewCandidate[] { return preview.candidates.filter((candidate) => candidate.disposition !== undefined) }

function importReadFailure(error: unknown): { code: string; message: string } {
  const codes: Record<string, string> = {
    ENOTFOUND: '域名解析失败', EAI_AGAIN: '域名解析暂时失败，请稍后重试',
    ECONNREFUSED: '目标网站拒绝连接', ECONNRESET: '连接被重置', ENETUNREACH: '目标网络不可达', EHOSTUNREACH: '目标主机不可达',
    ETIMEDOUT: '请求超时', UND_ERR_CONNECT_TIMEOUT: '连接超时', UND_ERR_HEADERS_TIMEOUT: '等待响应头超时', UND_ERR_BODY_TIMEOUT: '读取响应内容超时',
    UND_ERR_SOCKET: '网络连接中断', CERT_HAS_EXPIRED: '目标网站证书已过期', DEPTH_ZERO_SELF_SIGNED_CERT: '目标网站使用自签名证书',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证目标网站证书', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '无法验证目标网站证书链',
    SELF_SIGNED_CERT_IN_CHAIN: '目标网站证书链包含自签名证书', CERT_UNTRUSTED: '目标网站证书不受信任',
    ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: 'TLS 握手失败', ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 协议版本不匹配',
    ERR_TLS_CERT_ALTNAME_INVALID: '目标网站证书与域名不匹配', EPROTO: 'TLS 连接协商失败',
  }
  const messages: Record<string, { code: string; message: string }> = {
    'private network request is not allowed': { code: 'private-network', message: '目标或重定向地址指向受限制的网络' },
    'request protocol is not allowed': { code: 'protocol-blocked', message: '目标或重定向地址使用不支持的协议' },
    'request URL must not contain credentials': { code: 'url-credentials', message: '目标或重定向地址不能包含账号密码' },
    'response exceeds byte budget': { code: 'response-too-large', message: '下载内容超过大小限制' },
    'total response byte budget exceeded': { code: 'response-too-large', message: '下载内容超过总大小限制' },
    '导入内容超过总字节限制': { code: 'response-too-large', message: '下载内容超过总大小限制' },
    'redirect budget exceeded': { code: 'redirect-limit', message: '网站重定向次数超过限制' },
    'request count budget exceeded': { code: 'request-limit', message: '请求次数超过限制' },
  }
  // Node fetch 将网络错误放在 cause 中；聚合连接错误可能包含 IPv4/IPv6 的子错误。
  const pending: unknown[] = [error]
  for (let index = 0; index < pending.length && index < 16; index++) {
    const item = pending[index]
    if (!(item instanceof Error)) continue
    if (item.name === 'TimeoutError') return { code: 'timeout', message: '下载超时，请稍后重试' }
    if (item.name === 'AbortError') return { code: 'cancelled', message: '下载已取消' }
    const code = 'code' in item && typeof item.code === 'string' ? item.code : ''
    if (Object.hasOwn(codes, code)) return { code, message: codes[code]! }
    const known = Object.hasOwn(messages, item.message) ? messages[item.message] : undefined
    if (known !== undefined) return known
    // 只提取本模块生成的 HTTP 三位状态码，不回显外部错误文本。
    const http = /^导入链接返回 HTTP (\d{3})$/u.exec(item.message)
    if (http !== null) return { code: `HTTP-${http[1]}`, message: `目标网站返回 HTTP ${http[1]}` }
    if (item.cause !== undefined) pending.push(item.cause)
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 16))
  }
  return { code: 'network-error', message: '网络读取失败，未能取得有效响应' }
}
