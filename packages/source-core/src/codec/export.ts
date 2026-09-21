import { diagnostic } from '../diagnostics/diagnostics.ts'
import type { ExportOptions, ExportResult, ImportCandidate, JsonObject } from '../model/types.ts'

function cloneObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

export function exportSource(candidate: ImportCandidate, options: ExportOptions): ExportResult {
  if (candidate.source === undefined) {
    return { text: candidate.rawText, format: options.format, diagnostics: [diagnostic('unsupported-format', 'input', '无效候选不能导出为可保存书源')] }
  }
  if (options.patch === undefined && options.format === 'json' && candidate.raw.kind !== 'javascript') return { text: candidate.rawText, format: 'json', diagnostics: [] }
  if (options.patch === undefined && options.format === 'javascript' && candidate.raw.kind === 'javascript') return { text: candidate.rawText, format: 'javascript', diagnostics: [] }

  const source = cloneObject(candidate.source)
  if (options.patch !== undefined) Object.assign(source, cloneObject(options.patch))
  if (options.format === 'json') return { text: `${JSON.stringify(source, null, 2)}\n`, format: 'json', diagnostics: [] }
  return { text: `const config = ${JSON.stringify(source, null, 2)};\n`, format: 'javascript', diagnostics: [diagnostic('requires-javascript', 'parse', '修改后的 JavaScript 书源导出为静态 config 包装，完整脚本仅在未修改时逐字保留', { severity: 'info' })] }
}
