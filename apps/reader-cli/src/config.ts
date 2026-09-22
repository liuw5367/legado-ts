import { parseArgs } from 'node:util'

export interface ReaderConfig {
  source?: string
  help: boolean
  version: boolean
}

export function parseReaderArgs(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): ReaderConfig {
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

export const cliHelp = `legado-reader：命令行阅读器

用法：
  legado-reader --source <文件、目录或 HTTP(S) JSON 地址>
  LEGADO_READER_SOURCE=<来源> legado-reader

按键：Ctrl+K 搜书，Enter 打开，j/k 移动，Esc 返回，? 帮助，q 退出。
`
