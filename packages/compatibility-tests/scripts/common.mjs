import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const inputShapes = JSON.parse(await readFile(new URL('../schema/operations.json', import.meta.url), 'utf8'))

export const root = fileURLToPath(new URL('../', import.meta.url))
export const repository = resolve(root, '../..')
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
export const stable = (value) => JSON.stringify(sort(value))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
  return value
}
export const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
export async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (['node_modules', 'target', 'output', '.git'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await files(path))
    else paths.push(path)
  }
  return paths
}
export async function treeHash(directory) {
  const items = []
  for (const path of await files(directory)) items.push([path.slice(directory.length), sha256(await readFile(path))])
  return sha256(stable(items))
}
export async function loadCases(options = {}) {
  const cases = []
  const corpora = new Map()
  let yckManifest
  for (const path of await files(join(root, 'cases'))) {
    if (!path.endsWith('.json')) continue
    for (const item of await readJson(path)) {
      validateCase(item)
      if (item.flowOrigin?.sourceUrl || item.flowOrigin?.ruleFrom) {
        const collection = item.flowOrigin.collection ?? 'yiove'
        if (!corpora.has(collection)) corpora.set(collection, await loadFlowCorpus(collection))
        const corpus = corpora.get(collection)
        verifyFlowOrigin(item, corpus)
        item.flowOrigin.snapshotSha256 = corpus.sha256
      }
      if (item.operation === 'rule.scriptLibrary' && item.input.kind === 'date') {
        yckManifest ??= await readJson(join(root, 'corpus/yck-1298-manifest.json'))
        const source = yckManifest.entries.find((entry) => entry.fragments?.some((fragment) => fragment.caseId === item.id))
        const fragment = source?.fragments.find((fragment) => fragment.caseId === item.id)
        if (!fragment || fragment.sha256 !== sha256(item.input.library)) {
          throw new Error(`${item.id}: YCK jsLib 片段摘要与来源索引不一致`)
        }
        item.scriptOrigin = { sourceUrl: source.sourceUrl, sourceIndex: source.index, snapshotSha256: yckManifest.rawSha256, ...fragment }
      }
      cases.push(item)
    }
  }
  const ids = new Set()
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`重复案例 id: ${item.id}`)
    ids.add(item.id)
  }
  return cases.filter((item) => (!options.family || item.family === options.family) && (!options.case || item.id === options.case))
}
const flowCorpora = new Map([
  ['yiove', ['manifest.json', 'yiove-11-sources.json']],
  ['yck-1298', ['yck-1298-manifest.json', 'yck-1298-sources.json']],
])

export async function loadFlowCorpus(collection) {
  const files = flowCorpora.get(collection)
  if (!files) throw new Error('未知流程书源集合')
  const [manifestName, snapshotName] = files
  const manifest = await readJson(join(root, 'corpus', manifestName))
  if (manifest.file !== snapshotName) throw new Error('流程书源快照不在白名单')
  const snapshot = await readFile(join(root, 'corpus', snapshotName))
  return verifyFlowCorpus(manifest, snapshot)
}

export function verifyFlowCorpus(manifest, snapshot) {
  if (sha256(snapshot) !== manifest.sha256) throw new Error('书源快照摘要变化')
  const sources = JSON.parse(snapshot)
  if (!Array.isArray(sources)) throw new Error('书源快照必须是数组')
  if (manifest.entries) {
    const fixtures = manifest.entries.filter((entry) => entry.disposition === 'fixture')
    if (fixtures.length !== sources.length || !sources.every((source) =>
      fixtures.some((entry) => entry.sourceUrl === source.bookSourceUrl && entry.definitionSha256 === sha256(stable(source))))) {
      throw new Error('书源定义摘要与选用索引不一致')
    }
  }
  return { sources, sha256: manifest.sha256 }
}

export function verifyFlowOrigin(item, corpus) {
  const { sourceUrl, fields, ruleFrom } = item.flowOrigin
  if (sourceUrl) {
    const source = corpus.sources.find((s) => s.bookSourceUrl === sourceUrl)
    if (!source || stable(source) !== stable(item.input.source) || !fields.every((field) => Object.hasOwn(source, field))) {
      throw new Error(`${item.id}: 流程案例来源与书源快照不一致`)
    }
  }
  if (ruleFrom) {
    const source = corpus.sources.find((s) => s.bookSourceUrl === ruleFrom.sourceUrl)
    const readRule = (value) => ruleFrom.field.split('.').reduce((current, field) => current?.[field], value)
    const rule = readRule(source)
    if (typeof rule !== 'string' || readRule(item.input.source) !== rule) {
      throw new Error(`${item.id}: 流程规则片段与书源快照不一致`)
    }
  }
}

export function validateCase(item) {
  if (!item || !['id', 'family', 'operation'].every((key) => typeof item[key] === 'string' && item[key].length > 0)
      || !item.input || typeof item.input !== 'object' || Array.isArray(item.input)
      || !item.reference || !['jdk-direct', 'upstream-original', 'upstream-adapted', 'upstream-guided-flow'].includes(item.reference.kind)
      || typeof item.reference.method !== 'string' || !Array.isArray(item.tags)) throw new Error('案例协议无效')
  if (item.contractScope !== undefined && !['api', 'reference-observation', 'flow'].includes(item.contractScope)) throw new Error('契约范围无效')
  if (item.contractScope === 'reference-observation' && !(typeof item.observationReason === 'string' && item.observationReason.length > 0 && Array.isArray(item.relatedCases) && item.relatedCases.length > 0)) throw new Error('内部观察必须说明原因并关联可执行规则案例')
  for (const runtime of ['jvm', 'ts']) {
    const values = item.errorEquivalence?.[`${runtime}MessageIncludes`]
    if (values !== undefined && (!Array.isArray(values) || !values.every((v) => typeof v === 'string' && v.length > 0))) throw new Error('错误语义标记无效')
  }
  const shape = inputShapes[item.operation]
  if (!shape) throw new Error(`未声明操作输入契约: ${item.operation}`)
  for (const key of shape.required) {
    if (!Object.hasOwn(item.input, key)) throw new Error(`${item.id}: input 缺少 ${key}`)
  }
  for (const [key, value] of Object.entries(item.input)) {
    const type = shape.properties[key]
    const valid = type === 'strings' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : type === 'integer' ? Number.isSafeInteger(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : typeof value === type
    if (!valid) throw new Error(`${item.id}: input.${key} 类型无效`)
  }
  if (item.operation.startsWith('flow.')) validateFlowCase(item)
  if (item.operation === 'rule.split' && !['&&', '||', '%%'].includes(item.input.operator)) throw new Error('未支持的分隔符')
  if (item.operation.startsWith('regex.') && item.input.patterns.length === 0) throw new Error('patterns 不能为空')
  if (item.errorEquivalence && (typeof item.errorEquivalence.category !== 'string' || !['jvm', 'ts'].every((r) => Array.isArray(item.errorEquivalence[r]) && item.errorEquivalence[r].every((v) => typeof v === 'string')))) throw new Error('异常等价声明无效')
  if (item.allowedDifferences !== undefined) {
    if (!Array.isArray(item.allowedDifferences) || !item.allowedDifferences.every((d) => typeof d.path === 'string' && d.reason?.length > 0 && Object.hasOwn(d, 'jvm') && Object.hasOwn(d, 'ts'))) throw new Error('允许差异必须指定路径、双方值和原因')
  }
}
function validateFlowCase(item) {
  const { source, responses, requestLimit } = item.input
  const origin = item.flowOrigin
  if (item.contractScope !== 'flow' || item.reference.kind !== 'upstream-guided-flow' || item.allowedDifferences !== undefined
    || (item.input.stopAfter !== undefined && item.input.stopAfter !== 'detail')
    || (item.input.chapterIndex ?? 0) < 0 || typeof source.bookSourceUrl !== 'string' || requestLimit < 1 || Object.keys(responses).length === 0
    || !origin || (origin.collection !== undefined && !flowCorpora.has(origin.collection)) || (origin.sourceUrl ? !Array.isArray(origin.fields) || origin.fields.length === 0 : typeof origin.fixture !== 'string')) {
    throw new Error(`${item.id}: 流程来源、契约或请求预算无效`)
  }
  if (origin.ruleFrom !== undefined && (!URL.canParse(origin.ruleFrom?.sourceUrl) || typeof origin.ruleFrom?.field !== 'string')) {
    throw new Error(`${item.id}: 书源规则片段来源无效`)
  }
  if (item.operation === 'flow.toc') {
    const { book, bookVariables } = item.input
    if (!URL.canParse(book.bookUrl) || !URL.canParse(book.tocUrl) || Object.values(bookVariables).some((value) => typeof value !== 'string')) {
      throw new Error(`${item.id}: 目录阶段书籍身份或初始变量无效`)
    }
  }
  const keys = new Set()
  for (const entry of Object.values(responses)) {
    const response = entry?.response
    if (!['GET', 'POST'].includes(entry?.method) || !URL.canParse(entry.url) || (entry.body !== null && typeof entry.body !== 'string')
      || !response || !URL.canParse(response.url) || !Number.isInteger(response.status)
      || typeof response.base64 !== 'string' || Buffer.from(response.base64, 'base64').toString('base64') !== response.base64
      || !response.headers || Object.values(response.headers).some((value) => typeof value !== 'string')) {
      throw new Error(`${item.id}: 离线响应无效`)
    }
    const matchHeaders = entry.requestHeaders ?? {}
    if (typeof matchHeaders !== 'object' || Array.isArray(matchHeaders) || Object.entries(matchHeaders).some(([name, value]) =>
      name !== name.toLowerCase() || (value !== null && typeof value !== 'string'))) {
      throw new Error(`${item.id}: 离线请求头匹配无效`)
    }
    const key = stable([entry.method, entry.url, entry.body, matchHeaders])
    if (keys.has(key)) throw new Error(`${item.id}: 离线请求重复声明`)
    keys.add(key)
  }
  if (item.flowErrorEquivalence !== undefined) {
    const { stage, category, jvm, ts } = item.flowErrorEquivalence
    if (!['search', 'detail', 'toc', 'content'].includes(stage) || typeof category !== 'string' || !category
      || ![jvm, ts].every((error) => error && typeof error.class === 'string' && typeof error.message === 'string')) {
      throw new Error(`${item.id}: 流程错误等价声明无效`)
    }
  }
}

export function validateResult(result, id) {
  if (!result || result.id !== id || !['completed', 'unsupported', 'runner-failed'].includes(result.execution)) throw new Error('执行结果协议无效')
  if (result.execution === 'completed') {
    if (!['return', 'throw'].includes(result.outcome)) throw new Error('执行结果缺少 outcome')
    if (result.outcome === 'return' && !Object.hasOwn(result, 'value')) throw new Error('执行结果缺少 value')
    if (result.outcome === 'throw' && (!result.error || typeof result.error.class !== 'string' || typeof result.error.message !== 'string')) throw new Error('执行结果缺少 error')
  } else if (typeof result.reason !== 'string') throw new Error('执行结果缺少失败原因')
  return result
}
