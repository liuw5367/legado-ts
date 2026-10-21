import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { SourceRuntimePlatform, SourceRuntimePlatformContext } from '@legado/source-core'
import { s2tDictionaryGzipBase64, t2sDictionaryGzipBase64 } from './chinese-dictionaries.ts'

export interface NodeSourceRuntimePlatformOptions {
  /** Stable host seed. The default is process-local and must not be used for authentication. */
  deviceSeed?: string
  appVariant?: string
  readBookConfig?: Readonly<Record<string, unknown>>
  themeMode?: string
  themeConfig?: Readonly<Record<string, unknown>>
  sourceNavigationContext?: unknown | ((context: SourceRuntimePlatformContext) => unknown)
  t2s?: (value: string) => string
  s2t?: (value: string) => string
  /** Override selected capabilities while retaining the built-in pure ones. */
  invoke?: (capability: string, input: unknown, context: SourceRuntimePlatformContext) => unknown | Promise<unknown> | undefined
}

interface TrieNode {
  value?: string
  children: Map<string, TrieNode>
}

class DictionaryConverter {
  private readonly root: TrieNode = { children: new Map() }

  public constructor(encoded: string, overrides: ReadonlyMap<string, string> = new Map()) {
    const decoded = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8')
    for (const line of decoded.split(/\r?\n/u)) {
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      this.insert(line.slice(0, separator), line.slice(separator + 1))
    }
    for (const [from, to] of overrides) this.insert(from, to)
  }

  public convert(value: string): string {
    const chars = Array.from(value)
    const output: string[] = []
    for (let index = 0; index < chars.length;) {
      let replacement: string | undefined
      let selectedLength = 0
      let node = this.root
      for (let offset = 0; index + offset < chars.length; offset += 1) {
        const child = node.children.get(chars[index + offset]!)
        if (child === undefined) break
        node = child
        if (node.value !== undefined) {
          replacement = node.value
          selectedLength = offset + 1
        }
      }
      if (replacement === undefined) {
        output.push(chars[index]!)
        index += 1
      } else {
        output.push(replacement)
        index += selectedLength
      }
    }
    return output.join('')
  }

  private insert(from: string, to: string): void {
    const chars = Array.from(from)
    if (chars.length === 0) return
    let node = this.root
    for (const char of chars) {
      const child = node.children.get(char) ?? { children: new Map<string, TrieNode>() }
      node.children.set(char, child)
      node = child
    }
    node.value = to
  }
}

const t2sOverrides = new Map<string, string>([
  ['槃', '槃'], ['划槳', '划槳'], ['列根', '列根'], ['雪梨', '雪梨'], ['雪糕', '雪糕'], ['多士', '多士'], ['起司', '起司'], ['芝士', '芝士'], ['沙芬', '沙芬'], ['母音', '母音'],
  ['华乐', '华乐'], ['民乐', '民乐'], ['晶元', '晶元'], ['晶片', '晶片'], ['映像', '映像'], ['明覆', '明覆'], ['明瞭', '明瞭'], ['新力', '新力'], ['新喻', '新喻'],
  ['零錢', '零錢'], ['零钱', '零钱'], ['離線', '離線'], ['碟片', '碟片'], ['模組', '模組'], ['桌球', '桌球'], ['案頭', '案頭'], ['機車', '機車'], ['電漿', '電漿'],
  ['鳳梨', '鳳梨'], ['魔戒', '魔戒'], ['載入', '載入'], ['菲林', '菲林'], ['整合', '整合'], ['變數', '變數'], ['解碼', '解碼'], ['散钱', '散钱'], ['插水', '插水'],
  ['房屋', '房屋'], ['房价', '房价'], ['快取', '快取'], ['德士', '德士'], ['建立', '建立'], ['常式', '常式'], ['席丹', '席丹'], ['布殊', '布殊'],
  ['巴哈', '巴哈'], ['巨集', '巨集'], ['夜学', '夜学'], ['向量', '向量'], ['半形', '半形'], ['加彭', '加彭'], ['列印', '列印'], ['函式', '函式'], ['全形', '全形'],
  ['光碟', '光碟'], ['介面', '介面'], ['乳酪', '乳酪'], ['沈船', '沈船'], ['永珍', '永珍'], ['演化', '演化'], ['牛油', '牛油'], ['相容', '相容'],
  ['磁碟', '磁碟'], ['菲林', '菲林'], ['規則', '規則'], ['酵素', '酵素'], ['雷根', '雷根'], ['饭盒', '饭盒'], ['路易斯', '路易斯'], ['非同步', '非同步'],
  ['出租车', '出租车'], ['周杰倫', '周杰倫'], ['马铃薯', '马铃薯'], ['馬鈴薯', '馬鈴薯'], ['機械人', '機械人'], ['電單車', '電單車'], ['電扶梯', '電扶梯'],
  ['音效卡', '音效卡'], ['飆車族', '飆車族'], ['點陣圖', '點陣圖'], ['個入球', '個入球'], ['顆進球', '顆進球'], ['沃尓沃', '沃尓沃'], ['晶片集', '晶片集'],
  ['斯瓦巴', '斯瓦巴'], ['斜角巷', '斜角巷'], ['战列舰', '战列舰'], ['快速面', '快速面'], ['希特拉', '希特拉'], ['太空梭', '太空梭'], ['吐瓦魯', '吐瓦魯'],
  ['吉布堤', '吉布堤'], ['吉布地', '吉布地'], ['史太林', '史太林'], ['南冰洋', '南冰洋'], ['区域网', '区域网'], ['波札那', '波札那'], ['解析度', '解析度'],
  ['酷洛米', '酷洛米'], ['金夏沙', '金夏沙'], ['魔獸紀元', '魔獸紀元'], ['高空彈跳', '高空彈跳'], ['铁达尼号', '铁达尼号'], ['太空战士', '太空战士'],
  ['埃及妖后', '埃及妖后'], ['吉里巴斯', '吉里巴斯'], ['附加元件', '附加元件'], ['魔鬼終結者', '魔鬼終結者'], ['純文字檔案', '純文字檔案'],
  ['奇幻魔法Melody', '奇幻魔法Melody'], ['列支敦斯登', '列支敦斯登'],
])

export class NodeSourceRuntimePlatform implements SourceRuntimePlatform {
  private readonly options: NodeSourceRuntimePlatformOptions
  private readonly deviceId: string
  private readonly t2sConverter?: DictionaryConverter
  private readonly s2tConverter?: DictionaryConverter

  public constructor(options: NodeSourceRuntimePlatformOptions = {}) {
    this.options = options
    const seed = options.deviceSeed ?? `legado-node:${process.cwd()}`
    this.deviceId = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)
    if (options.t2s === undefined) this.t2sConverter = new DictionaryConverter(t2sDictionaryGzipBase64, t2sOverrides)
    if (options.s2t === undefined) this.s2tConverter = new DictionaryConverter(s2tDictionaryGzipBase64)
  }

  public invoke(capability: string, input: unknown, context: SourceRuntimePlatformContext): unknown | Promise<unknown> {
    const override = this.options.invoke?.(capability, input, context)
    if (override !== undefined) return override
    if (capability === 'java.t2s') return this.options.t2s?.(String(input ?? '')) ?? this.t2sConverter!.convert(String(input ?? ''))
    if (capability === 'java.s2t') return this.options.s2t?.(String(input ?? '')) ?? this.s2tConverter!.convert(String(input ?? ''))
    if (capability === 'androidId' || capability === 'deviceID') return this.deviceId
    if (capability === 'getAppVariant') return this.options.appVariant ?? 'node'
    if (capability === 'getReadBookConfig') return JSON.stringify(this.options.readBookConfig ?? {})
    if (capability === 'getReadBookConfigMap') return { ...(this.options.readBookConfig ?? {}) }
    if (capability === 'getThemeMode') return this.options.themeMode ?? '0'
    if (capability === 'getThemeConfig') return JSON.stringify(this.options.themeConfig ?? {})
    if (capability === 'getThemeConfigMap') return { ...(this.options.themeConfig ?? {}) }
    if (capability === 'getSourceNavigationContext') return typeof this.options.sourceNavigationContext === 'function' ? this.options.sourceNavigationContext(context) : this.options.sourceNavigationContext ?? { sourceKey: context.source.bookSourceUrl, sourceName: context.source.bookSourceName }
    throw new Error(`__LEGADO_CAPABILITY__runtime ${capability} unavailable`)
  }
}
