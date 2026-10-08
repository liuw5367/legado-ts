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

未配置来源时，使用构建时嵌入的默认书源（如果二进制包含）。

按键：Ctrl+K 搜书，j/k 或上下键移动，左右键/PageUp/PageDown 翻页，Home/End 或 Ctrl+A/Ctrl+E 跳首尾，首页/配置按 s 打开设置，↵ 打开，⎋ 返回，? 帮助，q 退出。
`
