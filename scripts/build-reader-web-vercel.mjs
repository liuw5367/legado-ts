import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`读取器 Web 构建进程启动失败：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Vercel 从干净 checkout 开始，不会有 workspace 包的 dist/。先生成 core 和
// Node runtime 的产物，Hono 函数入口才能解析书源运行时及 QuickJS 依赖。
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'])
run('pnpm', ['--filter', '@legado/source-node', 'build'])
run('pnpm', ['--filter', '@legado/reader-web', 'build'])

const sourceDirectory = resolve('apps/reader-web/dist')
const publicDirectory = resolve('public')
mkdirSync(publicDirectory, { recursive: true })

// Vercel 的 Hono 适配器从根目录 public/ 提供静态文件；Rsbuild 产物需要在构建结束后复制到这里。
for (const entry of readdirSync(sourceDirectory)) {
  cpSync(resolve(sourceDirectory, entry), resolve(publicDirectory, entry), { force: true, recursive: true })
}
