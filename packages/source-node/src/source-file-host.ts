import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequestPlan, splitSourceRequestUrl } from '@legado/source-core'
import type { ArchiveHost, NetworkHost, NormalizedSource, SourceFileHost, SourceFileOperation } from '@legado/source-core'
import chardet from 'chardet'
import { NodeArchiveHost } from './archive.ts'
import { NodeCharsetCodec } from './charset.ts'
import { NodeEncodingHost } from './encoding.ts'

export interface NodeSourceFileHostOptions {
  /** 受控阅读缓存根目录；所有书源路径都只能落在此目录下。 */
  root?: string
  network: NetworkHost
  /** 可选的源请求链；提供后下载会复用动态 header、登录头、Cookie 和 URL options。 */
  requestBytes?: (url: string, signal: AbortSignal, source: NormalizedSource) => Promise<Uint8Array>
  encoding?: NodeCharsetCodec
  archive?: ArchiveHost
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
}

function sourceKey(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex').slice(8, 24)
}

function extension(value: string): string {
  const parsed = splitSourceRequestUrl(value)
  const configured = parsed.options?.type
  if (typeof configured === 'string' && /^[A-Za-z0-9]{1,5}$/u.test(configured)) return configured
  try {
    const path = new URL(parsed.url).pathname
    const match = /\.([A-Za-z0-9]{1,12})$/u.exec(path)
    return match?.[1]?.toLowerCase() ?? 'ext'
  } catch {
    const match = /\.([A-Za-z0-9]{1,12})(?:$|[?#])/u.exec(parsed.url)
    return match?.[1]?.toLowerCase() ?? 'ext'
  }
}
function safeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter((item) => item.length > 0 && item !== '.')
  if (parts.some((item) => item === '..' || item.includes('\u0000'))) throw new Error('非法路径')
  return parts.join('/')
}

function charsetOf(value: unknown): string | undefined {
  const textValue = text(value).trim()
  return textValue.length === 0 ? undefined : textValue
}

function detectCharset(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  const detected = chardet.detect(Buffer.from(bytes))
  if (detected !== undefined && detected !== null) return detected
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    // Android's ICU detector generally selects a Chinese legacy charset for invalid UTF-8.
    return 'gb18030'
  }
}

/** Node 对 Android 阅读缓存目录 API 的受控实现。 */
export class NodeSourceFileHost implements SourceFileHost {
  private readonly root: string
  private readonly network: NetworkHost
  private readonly requestBytes?: NodeSourceFileHostOptions['requestBytes']
  private readonly encoding: NodeCharsetCodec
  private readonly binaryEncoding: NodeEncodingHost
  private readonly archive: ArchiveHost

  public constructor(options: NodeSourceFileHostOptions) {
    this.root = resolve(options.root ?? join(tmpdir(), 'legado-source-cache'))
    this.network = options.network
    this.requestBytes = options.requestBytes
    this.encoding = options.encoding ?? new NodeCharsetCodec()
    this.binaryEncoding = new NodeEncodingHost()
    this.archive = options.archive ?? new NodeArchiveHost()
  }

  public async execute(operation: SourceFileOperation, input: Readonly<Record<string, unknown>>, signal: AbortSignal, source: NormalizedSource): Promise<unknown> {
    if (signal.aborted) throw new Error('__LEGADO_CANCELLED__')
    await mkdir(this.root, { recursive: true })
    await this.assertNoSymlink('')
    if (operation === 'getFile') return this.fileInfo(text(input.path))
    if (operation === 'listFiles') return this.listFiles(text(input.path))
    if (operation === 'readFile') return this.readBytes(text(input.path))
    if (operation === 'readTxtFile') return this.readText(text(input.path), charsetOf(input.charset))
    if (operation === 'deleteFile') return this.deletePath(text(input.path))
    if (operation === 'downloadFile') return this.downloadFile(input, signal, source)
    if (operation === 'cacheFile') return this.cacheFile(text(input.url), Number(input.saveTime) || 0, signal, source)
    if (operation === 'importScript') return this.importScript(text(input.path), signal, source)
    if (operation === 'getTxtInFolder') return this.getTxtInFolder(text(input.path))
    if (operation === 'unzipFile' || operation === 'un7zFile' || operation === 'unrarFile' || operation === 'unArchiveFile') return this.unpack(operation, text(input.path), signal)
    if (operation === 'getZipStringContent' || operation === 'getRarStringContent' || operation === 'get7zStringContent') {
      const format = operation.startsWith('getZip') ? 'zip' : operation.startsWith('getRar') ? 'rar' : '7z'
      const bytes = await this.archiveContent(text(input.url), text(input.path), format, signal, source)
      if (bytes === undefined) return ''
      const charset = charsetOf(input.charset) ?? detectCharset(bytes)
      return this.encoding.decode(bytes, charset)
    }
    if (operation === 'getZipByteArrayContent' || operation === 'getRarByteArrayContent' || operation === 'get7zByteArrayContent') {
      const format = operation.startsWith('getZip') ? 'zip' : operation.startsWith('getRar') ? 'rar' : '7z'
      return this.archiveContent(text(input.url), text(input.path), format, signal, source)
    }
    throw new Error(`__LEGADO_CAPABILITY__runtime file.${operation} unavailable`)
  }

  /** CacheManager.delete(md5-16(url)) invalidates the Android cache mapping. */
  public async invalidateCacheFile(key: string, signal: AbortSignal, _source: NormalizedSource): Promise<void> {
    if (signal.aborted) throw new Error('__LEGADO_CANCELLED__')
    const safeKey = safeRelative(key)
    if (!/^[a-f\d]{16}$/iu.test(safeKey)) return
    const metadata = this.absolute(`.legado-meta/${safeKey}.json`)
    await this.assertNoSymlink(metadata.relative)
    await rm(metadata.absolute, { force: true })
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (!name.startsWith(`${safeKey}.`)) continue
      await rm(this.absolute(name).absolute, { force: true })
    }
  }

  private absolute(value: string): { relative: string; absolute: string } {
    const relativePath = safeRelative(value)
    const absolute = resolve(this.root, relativePath)
    const outside = relative(this.root, absolute)
    if (outside === '..' || outside.startsWith(`..${sep}`) || outside.includes('\u0000')) throw new Error('非法路径')
    return { relative: relativePath, absolute }
  }

  private async fileInfo(path: string): Promise<Readonly<Record<string, unknown>>> {
    const target = this.absolute(path)
    await this.assertNoSymlink(target.relative)
    try {
      const value = await stat(target.absolute)
      return { path: target.relative, absolutePath: target.relative, name: target.relative.split('/').at(-1) ?? '', length: value.isFile() ? value.size : 0, lastModified: value.mtimeMs, exists: true, isFile: value.isFile(), isDirectory: value.isDirectory() }
    } catch {
      return { path: target.relative, absolutePath: target.relative, name: target.relative.split('/').at(-1) ?? '', length: 0, lastModified: 0, exists: false, isFile: false, isDirectory: false }
    }
  }

  private async listFiles(path: string): Promise<Array<Readonly<Record<string, unknown>>>> {
    const target = this.absolute(path)
    await this.assertNoSymlink(target.relative)
    let names: string[]
    try { names = await readdir(target.absolute) } catch { return [] }
    const result: Array<Readonly<Record<string, unknown>>> = []
    for (const name of names) {
      const child = join(target.relative, name)
      const childInfo = await this.fileInfo(child)
      if (childInfo.exists === true) result.push(childInfo)
    }
    return result
  }

  private async readBytes(path: string): Promise<Uint8Array | null> {
    const target = this.absolute(path)
    await this.assertNoSymlink(target.relative)
    try { return Uint8Array.from(await readFile(target.absolute)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async readText(path: string, charset: string | undefined): Promise<string> {
    const bytes = await this.readBytes(path)
    if (bytes === null) return ''
    if (charset !== undefined) return this.encoding.decode(bytes, charset)
    return this.encoding.decode(bytes, detectCharset(bytes))
  }

  private async deletePath(path: string): Promise<boolean> {
    const target = this.absolute(path)
    await this.assertNoSymlink(target.relative)
    try { await stat(target.absolute) } catch { return false }
    try { await rm(target.absolute, { recursive: true, force: true }); return true } catch { return false }
  }

  private async importScript(path: string, signal: AbortSignal, source: NormalizedSource): Promise<string> {
    const value = path.trim()
    const result = /^https?:\/\//iu.test(value) ? await this.cacheFile(value, 0, signal, source) : await this.readText(value, undefined)
    if (result.trim().length === 0) throw new Error(`${path} 内容获取失败或者为空`)
    return result
  }

  private async cacheFile(url: string, saveTime: number, signal: AbortSignal, source: NormalizedSource): Promise<string> {
    const key = sourceKey(url)
    const path = `${key}.${extension(url)}`
    const target = this.absolute(path)
    const metadata = this.absolute(`.legado-meta/${key}.json`)
    await this.assertNoSymlink(target.relative)
    await this.assertNoSymlink(metadata.relative)
    let expiry: number | undefined
    try {
      const value = JSON.parse(await readFile(metadata.absolute, 'utf8')) as { expiresAt?: unknown }
      if (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)) expiry = value.expiresAt
    } catch {
      // Old cache files without metadata remain usable; the next write establishes the TTL.
    }
    try {
      const cached = await stat(target.absolute)
      if (cached.isFile()) {
        const expiresAt = expiry ?? (saveTime > 0 ? cached.mtimeMs + saveTime * 1000 : 0)
        if (expiresAt === 0 || expiresAt > Date.now()) {
          await mkdir(join(metadata.absolute, '..'), { recursive: true })
          await writeFile(metadata.absolute, JSON.stringify({ expiresAt }), 'utf8')
          return this.readText(path, undefined)
        }
      }
    } catch {
      // cache miss
    }
    await this.downloadTo(url, path, signal, source)
    const expiresAt = saveTime > 0 ? Date.now() + saveTime * 1000 : 0
    await mkdir(join(metadata.absolute, '..'), { recursive: true })
    await writeFile(metadata.absolute, JSON.stringify({ expiresAt }), 'utf8')
    return this.readText(path, undefined)
  }

  private async downloadFile(input: Readonly<Record<string, unknown>>, signal: AbortSignal, source: NormalizedSource): Promise<string> {
    const url = text(input.url)
    const path = `${sourceKey(url)}.${extension(url)}`
    const content = input.content
    if (content !== undefined) {
      const bytes = this.binaryEncoding.hexDecode(text(content))
      const target = this.absolute(path)
      await this.assertNoSymlink(target.relative)
      await mkdir(join(target.absolute, '..'), { recursive: true })
      await writeFile(target.absolute, Buffer.from(bytes))
      return `/${path}`
    }
    await this.downloadTo(url, path, signal, source)
    return `/${path}`
  }

  private async downloadTo(url: string, path: string, signal: AbortSignal, source: NormalizedSource): Promise<void> {
    if (this.requestBytes !== undefined) {
      const bytes = await this.requestBytes(url, signal, source)
      const target = this.absolute(path)
      await this.assertNoSymlink(target.relative)
      await mkdir(join(target.absolute, '..'), { recursive: true })
      await writeFile(target.absolute, Buffer.from(bytes))
      return
    }
    const plan = createRequestPlan({ url, baseUrl: source.bookSourceUrl, method: 'GET', responseType: 'bytes', followRedirects: true, budget: { timeoutMs: 30_000, maxRequests: 1, maxPages: 5, maxResponseBytes: 32 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxRequestBodyBytes: 0, maxRedirects: 5 }, execution: { useWebView: false } })
    if (plan.plan === undefined) throw new Error(plan.error?.message ?? '下载地址无效')
    plan.plan.budget.signal = signal
    const response = await this.network.request(plan.plan)
    const target = this.absolute(path)
    await this.assertNoSymlink(target.relative)
    await mkdir(join(target.absolute, '..'), { recursive: true })
    await writeFile(target.absolute, Buffer.from(response.bytes))
  }

  private async unpack(operation: SourceFileOperation, path: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) return ''
    const input = await this.readBytes(path)
    if (input === null) return ''
    const format = operation === 'un7zFile' ? '7z' : operation === 'unrarFile' ? 'rar' : extension(path) === 'gz' ? 'gzip' : extension(path) === 'zip' || operation === 'unzipFile' ? 'zip' : extension(path) === '7z' ? '7z' : 'rar'
    const entries = await this.archive.extract(input, format, {}, signal)
    const name = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
    const folder = `temp/${sourceKey(name)}`
    for (const entry of entries) {
      const target = this.absolute(join(folder, entry.path))
      await this.assertNoSymlink(target.relative)
      await mkdir(join(target.absolute, '..'), { recursive: true })
      await writeFile(target.absolute, Buffer.from(entry.data))
    }
    return folder
  }

  private async archiveContent(urlOrHex: string, path: string, format: 'zip' | 'rar' | '7z', signal: AbortSignal, source: NormalizedSource): Promise<Uint8Array | undefined> {
    const bytes = /^https?:\/\//iu.test(urlOrHex) ? await this.downloadBytes(urlOrHex, signal, source) : this.binaryEncoding.hexDecode(urlOrHex)
    const entries = await this.archive.extract(bytes, format, {}, signal)
    return entries.find((entry) => entry.path === safeRelative(path))?.data
  }

  private async downloadBytes(url: string, signal: AbortSignal, source: NormalizedSource): Promise<Uint8Array> {
    if (this.requestBytes !== undefined) return this.requestBytes(url, signal, source)
    const plan = createRequestPlan({ url, baseUrl: source.bookSourceUrl, method: 'GET', responseType: 'bytes', followRedirects: true, budget: { timeoutMs: 30_000, maxRequests: 1, maxPages: 5, maxResponseBytes: 32 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxRequestBodyBytes: 0, maxRedirects: 5 }, execution: { useWebView: false } })
    if (plan.plan === undefined) throw new Error(plan.error?.message ?? '归档地址无效')
    plan.plan.budget.signal = signal
    return (await this.network.request(plan.plan)).bytes
  }

  private async getTxtInFolder(path: string): Promise<string> {
    if (path.trim().length === 0) return ''
    const target = this.absolute(path)
    await this.assertNoSymlink(target.relative)
    let names: string[]
    try { names = await readdir(target.absolute) } catch { return '' }
    const values: string[] = []
    for (const name of names) {
      const child = this.absolute(join(path, name))
      try {
        const childStat = await lstat(child.absolute)
        if (childStat.isSymbolicLink()) throw new Error('非法路径')
        if (childStat.isFile()) values.push(await this.readText(join(path, name), undefined))
      } catch (error) {
        if (error instanceof Error && error.message === '非法路径') throw error
        /* file disappeared */
      }
    }
    await rm(target.absolute, { recursive: true, force: true })
    return values.join('\n')
  }

  private async assertNoSymlink(path: string): Promise<void> {
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error('非法路径')
    let current = this.root
    const relativePath = safeRelative(path)
    for (const part of relativePath.length === 0 ? [] : relativePath.split('/')) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('非法路径')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
  }
}
