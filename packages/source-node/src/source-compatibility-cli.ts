import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildStaticCompatibilityReport, loadSourceFixtureCandidates } from './source-compatibility.ts'
import { runLiveCompatibility } from './source-compatibility-live.ts'

interface CliOptions {
  mode: 'static' | 'live'
  report: string
  keyword: string
  maxSources?: number
  timeoutMs?: number
}

function options(argv: readonly string[]): CliOptions {
  const result: CliOptions = { mode: 'static', report: '/private/tmp/source-compatibility-static.json', keyword: '我本无意成仙' }
  let reportSpecified = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--mode' && argv[index + 1] === 'live') result.mode = 'live'
    if (value === '--report') { result.report = argv[++index] ?? result.report; reportSpecified = true }
    else if (value === '--keyword') result.keyword = argv[++index] ?? result.keyword
    else if (value === '--max-sources') {
      const maxSources = Number(argv[++index])
      if (Number.isInteger(maxSources) && maxSources > 0) result.maxSources = maxSources
    } else if (value === '--timeout-ms') {
      const timeoutMs = Number(argv[++index])
      if (Number.isInteger(timeoutMs) && timeoutMs > 0) result.timeoutMs = timeoutMs
    }
  }
  if (result.mode === 'live' && !reportSpecified) result.report = '/private/tmp/source-compatibility-live.json'
  return result
}

const config = options(process.argv.slice(2))
const candidates = await loadSourceFixtureCandidates()
const staticReport = buildStaticCompatibilityReport(candidates, config.keyword)
const report = config.mode === 'live'
  ? await runLiveCompatibility(candidates, staticReport, { keyword: config.keyword, ...(config.maxSources === undefined ? {} : { maxSources: config.maxSources }), ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) })
  : staticReport
await mkdir(dirname(config.report), { recursive: true })
await writeFile(config.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ mode: config.mode, report: config.report, summary: report.summary }))
if (config.mode === 'static' && (staticReport.summary.invalid > 0 || staticReport.summary.uncompiledRules > 0)) process.exitCode = 1
