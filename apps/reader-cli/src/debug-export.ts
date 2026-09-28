import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { DebugCapture, redactText, type DebugSessionSnapshot, type ProcessRecord, type RequestRecord } from './debug-capture.ts'

export interface ExportResult {
  markdownPath: string
  jsonPath: string
}

export async function exportDebugSession(capture: DebugCapture, directory = join(homedir(), '.legado-reader', 'exports')): Promise<ExportResult> {
  const snapshot = capture.snapshot()
  await mkdir(directory, { recursive: true })
  const stem = `debug-${safeName(snapshot.sourceName)}-${timestamp()}`
  const markdownPath = join(directory, `${stem}.md`)
  const jsonPath = join(directory, `${stem}.json`)
  await writeFile(markdownPath, toMarkdown(snapshot), 'utf8')
  await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  return { markdownPath, jsonPath }
}

export async function copyDebugPanel(text: string): Promise<{ copied: boolean; message: string }> {
  const command = clipboardCommand()
  if (command === undefined) return { copied: false, message: '当前系统没有可用剪贴板命令，请使用 e 导出文件' }
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: false, stdio: ['pipe', 'ignore', 'pipe'] })
    let error = ''
    child.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString() })
    child.once('error', () => resolve({ copied: false, message: `剪贴板命令不可用，请使用 e 导出文件${error.length > 0 ? `：${error.trim()}` : ''}` }))
    child.once('close', (code) => resolve(code === 0 ? { copied: true, message: '当前面板已复制' } : { copied: false, message: `复制失败，请使用 e 导出文件${error.length > 0 ? `：${error.trim()}` : ''}` }))
    child.stdin?.end(text)
  })
}

export function panelText(capture: DebugCapture, panel: 'flow' | 'requests' | 'response' | 'parsed', selectedRequest?: number, filter = ''): string {
  const snapshot = capture.snapshot()
  if (panel === 'flow') return snapshot.processes.filter((item) => matchesFilter(`${item.stage} ${item.kind} ${item.target} ${item.outputSummary ?? ''}`, filter)).map(formatProcess).join('\n') || '暂无处理流程记录。'
  if (panel === 'requests') return snapshot.requests.filter((item) => matchesFilter(`${item.sequence} ${item.stage} ${item.sourceId} ${item.sourceName ?? ''} ${item.method} ${item.url} ${item.status ?? ''} ${item.error ?? ''}`, filter)).map(formatRequest).join('\n') || '暂无请求记录。'
  if (panel === 'parsed') return snapshot.stages.map((stage) => `${stage.stage}  ${stage.status}  ${Object.entries(stage.summary).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join(' · ')}`).join('\n') || '暂无解析结果。'
  const request = snapshot.requests[selectedRequest ?? Math.max(0, snapshot.requests.length - 1)]
  if (request === undefined) return '暂无响应记录。'
  const response = (request.responseText ?? '（没有可显示的响应正文）').split('\n').filter((line) => matchesFilter(line, filter))
  return [`请求 ${request.sequence}`, `来源  ${request.sourceName ?? request.sourceId}`, `状态  ${request.status === undefined ? request.error ?? '未完成' : `HTTP ${request.status}`}`, `地址  ${request.finalUrl ?? request.url}`, `耗时  ${request.durationMs}ms`, '请求头', formatHeaders(request.headers), ...(request.requestBody === undefined ? [] : ['请求体', redactText(request.requestBody, 4096)]), '响应头', formatHeaders(request.responseHeaders), ...(filter.length === 0 ? [] : [`过滤：${response.length} 行`]), response.join('\n'), request.truncated ? '（响应已截断）' : ''].filter((line) => line.length > 0).join('\n')
}

function matchesFilter(value: string, filter: string): boolean {
  return filter.length === 0 || value.toLowerCase().includes(filter.toLowerCase())
}

function toMarkdown(snapshot: DebugSessionSnapshot): string {
  const lines = [`# 书源调试记录`, '', `- 书源：${redactText(snapshot.sourceName, 200)}`, `- 地址：${redactText(snapshot.sourceId, 500)}`, `- 模式：${snapshot.mode}`, `- 请求：${snapshot.requests.length}`, `- 处理记录：${snapshot.processes.length}`, `- 内容截断：${snapshot.truncated ? '是' : '否'}`, '']
  for (const stage of snapshot.stages) {
    lines.push(`## 阶段：${stage.stage}`, '', `状态：${stage.status}`)
    if (stage.durationMs !== undefined) lines.push(`耗时：${stage.durationMs}ms`)
    if (Object.keys(stage.summary).length > 0) lines.push(`摘要：${Object.entries(stage.summary).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`).join(' · ')}`)
    for (const diagnostic of stage.diagnostics) lines.push(`- 诊断：${redactText(diagnostic.message, 1000)}`)
    lines.push('')
  }
  lines.push('## 请求记录', '')
  for (const request of snapshot.requests) {
    lines.push(`### #${request.sequence} ${request.method} ${request.url}`, '', `- 来源：${redactText(request.sourceName ?? request.sourceId, 500)}`, `- 阶段：${request.stage}`, `- 最终 URL：${request.finalUrl ?? request.url}`, `- 重定向：${request.redirected === true ? '是' : '否'}`, `- 状态：${request.status === undefined ? request.error ?? '未完成' : `HTTP ${request.status}`}`, `- 耗时：${request.durationMs}ms`, `- 响应大小：${request.responseBytes} bytes${request.truncated ? '（已截断）' : ''}`, '', '请求头：', '```text', formatHeaders(request.headers), '```')
    if (request.requestBody !== undefined) lines.push('', '请求体：', '```text', redactText(request.requestBody, 4096), '```')
    lines.push('', '响应头：', '```text', formatHeaders(request.responseHeaders), '```', '', '响应正文：', '```text', request.responseText ?? '（没有可显示的响应正文）', '```', '')
  }
  lines.push('## 处理流程', '', ...snapshot.processes.map((item) => `- #${item.sequence} [${item.stage}] ${item.kind} ${item.state} ${item.target}${item.outputSummary === undefined ? '' : `：${redactText(item.outputSummary, 500)}`}`), '')
  return `${lines.join('\n')}\n`
}

function formatRequest(request: RequestRecord): string {
  return `${String(request.sequence).padStart(3, ' ')}  [${request.stage}] ${request.status === undefined ? '----' : String(request.status).padStart(3, ' ')}  ${String(request.durationMs).padStart(5, ' ')}ms  ${request.method} ${request.url}${request.error === undefined ? '' : `  ${request.error}`}`
}

function formatProcess(process: ProcessRecord): string {
  return `${String(process.sequence).padStart(3, ' ')}  [${process.stage}] ${process.state.padEnd(9, ' ')} ${process.kind.padEnd(15, ' ')} ${process.target}${process.outputSummary === undefined ? '' : ` · ${redactText(process.outputSummary, 300)}`}`
}

function formatHeaders(headers: Readonly<Record<string, string | string[]>> | undefined): string {
  if (headers === undefined || Object.keys(headers).length === 0) return '（无）'
  return Object.entries(headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n')
}

function clipboardCommand(): string | undefined {
  const current = platform()
  if (current === 'darwin') return 'pbcopy'
  if (current === 'win32') return 'clip'
  return process.env.WAYLAND_DISPLAY === undefined ? 'xclip' : 'wl-copy'
}

function safeName(value: string): string {
  const name = value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return name || 'source'
}

function timestamp(): string {
  return new Date().toISOString().replace(/[.:]/g, '-')
}
