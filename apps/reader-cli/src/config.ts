import { parseArgs } from 'node:util'
import type { BackupCategory } from '@legado/reader-backup'

export interface BackupCommand {
  action: 'export' | 'import'
  path: string
  categories?: BackupCategory[]
  yes: boolean
}

export interface ReaderConfig {
  source?: string
  help: boolean
  version: boolean
  backup?: BackupCommand
}

export function parseReaderArgs(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): ReaderConfig {
  if (args[0] === 'backup') return parseBackupArgs(args)
  const parsed = parseArgs({
    args: [...args],
    options: {
      source: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: false,
    strict: true,
  })
  const source = parsed.values.source ?? environment.LEGADO_READER_SOURCE
  return { ...(source === undefined ? {} : { source }), help: parsed.values.help === true, version: parsed.values.version === true }
}

function parseBackupArgs(args: readonly string[]): ReaderConfig {
  const action = args[1]
  if (action !== 'export' && action !== 'import') throw new Error('backup 后必须指定 export 或 import')
  const path = args[2]
  if (path === undefined || path.trim().length === 0 || path.startsWith('-')) throw new Error('backup 命令需要 ZIP 文件路径')
  let categories: BackupCategory[] | undefined
  let yes = false
  for (let index = 3; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--yes') { yes = true; continue }
    if (arg === '--categories') {
      const value = args[++index]
      if (value === undefined) throw new Error('--categories 缺少值')
      categories = parseCategories(value)
      continue
    }
    throw new Error(`backup 命令不支持参数：${arg}`)
  }
  if (action === 'export' && categories !== undefined) throw new Error('backup export 不需要 --categories')
  return { help: false, version: false, backup: { action, path, ...(categories === undefined ? {} : { categories }), yes } }
}

function parseCategories(value: string): BackupCategory[] {
  const names = value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  const allowed = new Set<BackupCategory>(['bookshelf', 'reading', 'search', 'sources', 'settings'])
  const result = [...new Set(names)]
  if (result.length === 0 || result.some((item) => !allowed.has(item as BackupCategory))) throw new Error('--categories 只允许 bookshelf、reading、search、sources、settings')
  return result as BackupCategory[]
}

export const cliHelp = `legado-reader：命令行阅读器

用法：
  legado-reader --source <文件、目录或 HTTP(S) JSON 地址>
  LEGADO_READER_SOURCE=<来源> legado-reader
  legado-reader backup export <文件.zip>
  legado-reader backup import <文件.zip> [--categories bookshelf,reading,search,sources,settings] [--yes]

未配置来源时，使用构建时嵌入的默认书源（如果二进制包含）。

按键：Ctrl+K 搜书，j/k 或上下键移动，左右键/PageUp/PageDown 翻页，Home/End 或 Ctrl+A/Ctrl+E 跳首尾，首页/配置按 s 打开设置，↵ 打开，⎋ 返回，? 帮助，q 退出。
`
