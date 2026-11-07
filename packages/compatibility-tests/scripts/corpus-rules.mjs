import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCases, readJson, root, sha256 } from './common.mjs'

const sections = ['ruleSearch', 'ruleExplore', 'ruleBookInfo', 'ruleToc', 'ruleContent']

function fieldRole(field) {
  if (field === 'checkKeyWord' || field === 'imageStyle') return 'configuration'
  if (field === 'hasMoreRule') return 'pagination'
  if (field === 'sourceRegex') return 'source-regex'
  if (field === 'replaceRegex') return 'replace-regex'
  if (field === 'bookList' || field === 'chapterList' || field === 'init') return 'nodes'
  return 'field'
}

export async function collectCorpusRules() {
  const manifest = await readJson(join(root, 'corpus/manifest.json'))
  const file = `corpus/${manifest.file}`
  const bytes = await readFile(join(root, file))
  if (sha256(bytes) !== manifest.sha256) throw new Error('书源快照摘要与清单不一致')
  const sources = JSON.parse(bytes)
  if (!Array.isArray(sources) || sources.length !== manifest.count) throw new Error('书源数量与清单不一致')

  const rules = new Map()
  const byOrigin = new Map()
  for (const [index, source] of sources.entries()) {
    for (const section of sections) {
      for (const [field, text] of Object.entries(source[section] ?? {})) {
        if (typeof text !== 'string' || text.trim() === '') continue
        const origin = { file, index, field: `${section}.${field}`, role: fieldRole(field) }
        const hash = sha256(text)
        if (!rules.has(hash)) rules.set(hash, { sha256: hash, text, origins: [], caseIds: [] })
        const rule = rules.get(hash)
        rule.origins.push(origin)
        byOrigin.set(`${index}:${origin.field}`, rule)
      }
    }
  }

  for (const item of await loadCases()) {
    const origin = item.origin
    if (origin?.file !== file) continue
    const rule = byOrigin.get(`${origin.index}:${origin.field}`)
    if (!rule || rule.text !== item.input.rule) throw new Error(`案例 ${item.id} 与书源原始规则不一致`)
    rule.caseIds.push(item.id)
  }
  return { file, sourceCount: sources.length, rules: [...rules.values()] }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(await collectCorpusRules(), null, 2) + '\n')
}
