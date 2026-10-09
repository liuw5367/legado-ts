import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const build = spawnSync('pnpm', ['--filter', '@legado/reader-web', 'build'], { stdio: 'inherit' })
if (build.error !== undefined) {
  console.error(`读取器 Web 构建进程启动失败：${build.error.message}`)
  process.exit(1)
}
if (build.status !== 0) process.exit(build.status ?? 1)

const sourceDirectory = resolve('apps/reader-web/dist')
const publicDirectory = resolve('public')
mkdirSync(publicDirectory, { recursive: true })

// Vercel 的 Hono 适配器从根目录 public/ 提供静态文件；Rsbuild 产物需要在构建结束后复制到这里。
for (const entry of readdirSync(sourceDirectory)) {
  cpSync(resolve(sourceDirectory, entry), resolve(publicDirectory, entry), { force: true, recursive: true })
}
