import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/**
 * 解析部署产物的根目录。Vercel 构建后使用仓库根目录的 public/；本地开发和
 * 未执行构建时回退到应用内的模板目录，保证 SPA 路由仍然可以被直接验收。
 */
function publicDirectories(): string[] {
  return [
    resolve(process.cwd(), 'public'),
    fileURLToPath(new URL('../../../public/', import.meta.url)),
    fileURLToPath(new URL('../public/', import.meta.url)),
  ]
}

function assetPath(pathname: string): { relativePath: string; immutable: boolean } | undefined {
  if (pathname === '/' || pathname === '/index.html') return { relativePath: 'index.html', immutable: false }
  if (!pathname.startsWith('/static/')) return { relativePath: 'index.html', immutable: false }

  let relativePath: string
  try {
    relativePath = decodeURIComponent(pathname.slice('/'.length))
  } catch {
    return undefined
  }
  if (relativePath.length === 0 || relativePath.includes('\0')) return undefined
  return { relativePath, immutable: true }
}

function isInside(directory: string, filePath: string): boolean {
  const relativePath = relative(directory, filePath)
  return relativePath.length === 0 || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

/**
 * 为 Vercel Hono 函数提供生成后的 SPA 入口和静态资源回退。
 * 返回 undefined 时交给后续 API 404 处理；只接受 public/ 下的 index.html 和 static/ 文件。
 */
export async function serveReaderAsset(pathname: string, method: string): Promise<Response | undefined> {
  if (pathname === '/api' || pathname.startsWith('/api/')) return undefined
  const asset = assetPath(pathname)
  if (asset === undefined) return undefined

  for (const directory of publicDirectories()) {
    const filePath = resolve(directory, asset.relativePath)
    if (!isInside(directory, filePath)) continue
    try {
      const body = await readFile(filePath)
      const headers = new Headers({
        'Content-Length': String(body.byteLength),
        'Content-Type': contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      })
      if (asset.immutable) headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      // Node 的 Buffer 是有效的 fetch 二进制响应体，但 DOM 类型定义没有声明 Buffer。
      return new Response(method === 'HEAD' ? undefined : (body as unknown as BodyInit), { headers })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
  }
  return undefined
}
