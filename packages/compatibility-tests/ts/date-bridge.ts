import { SourceRuleHost } from '../../source-node/src/source-rule-host.ts'
import type { NormalizedSource } from '../../source-core/src/index.ts'

const source = {
  bookSourceUrl: 'https://fixture.invalid',
  bookSourceName: 'compatibility-tests',
} as NormalizedSource

function string(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') throw new Error(`日期桥接缺少字符串参数: ${key}`)
  return input[key] as string
}

/** 使用真实 QuickJS java.timeFormat/timeFormatUTC bridge 执行共享日期脚本。 */
export async function executeDateBridge(input: Record<string, unknown>): Promise<unknown> {
  const host = new SourceRuleHost({ locale: string(input, 'locale'), timeZone: string(input, 'timeZone') })
  const program = string(input, 'program')
  const code = `JSON.stringify((function(){\n${program}\n})())`
  const result = await host.executeJavaScript(code, 'search', source, '')
  if (result.status !== 'success' && result.status !== 'empty') throw new Error(result.message ?? result.status)
  return JSON.parse(String(result.value)) as unknown
}
