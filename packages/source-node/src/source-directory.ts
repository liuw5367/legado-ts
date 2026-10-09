import { lstat, readdir, readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

export const SOURCE_DIRECTORY_MAX_FILES = 256
export const SOURCE_FILE_MAX_BYTES = 4 * 1024 * 1024

export interface SourceDirectoryInput {
  text: string
  location: string
}

export interface SourceDirectoryResult {
  inputs: SourceDirectoryInput[]
  diagnostics: string[]
}

export interface SourceDirectoryOptions {
  maxFiles?: number
  maxBytes?: number
}

/** 按 CLI 书源目录规则递归收集 .json/.js 文件，跳过符号链接并保持稳定顺序。 */
export async function readSourcePath(location: string, options: SourceDirectoryOptions = {}): Promise<SourceDirectoryResult> {
  const diagnostics: string[] = []
  const inputs: SourceDirectoryInput[] = []
  const path = resolve(location)
  const maxFiles = options.maxFiles ?? SOURCE_DIRECTORY_MAX_FILES
  const maxBytes = options.maxBytes ?? SOURCE_FILE_MAX_BYTES
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined) diagnostics.push(`书源路径不存在：${path}`)
  else if (info.isSymbolicLink()) diagnostics.push(`拒绝读取符号链接：${path}`)
  else if (info.isDirectory()) await collectDirectory(path, inputs, diagnostics, maxFiles, maxBytes)
  else if (info.isFile()) await collectFile(path, inputs, diagnostics, maxBytes)
  else diagnostics.push(`书源路径不是普通文件或目录：${path}`)
  return { inputs, diagnostics }
}

async function collectDirectory(path: string, inputs: SourceDirectoryInput[], diagnostics: string[], maxFiles: number, maxBytes: number): Promise<void> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    if (files.length >= maxFiles) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxFiles) break
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && ['.json', '.js'].includes(extname(entry.name).toLowerCase())) files.push(child)
    }
  }
  await visit(path)
  if (files.length >= maxFiles) diagnostics.push(`书源目录达到文件上限 ${maxFiles}，其余文件未读取`)
  for (const file of files) await collectFile(file, inputs, diagnostics, maxBytes)
}

async function collectFile(path: string, inputs: SourceDirectoryInput[], diagnostics: string[], maxBytes: number): Promise<void> {
  try {
    const text = await readFile(path, 'utf8')
    if (new TextEncoder().encode(text).byteLength > maxBytes) diagnostics.push(`书源文件超过 ${maxBytes} 字节：${path}`)
    else inputs.push({ text, location: path })
  } catch (error) {
    diagnostics.push(`书源文件读取失败：${path}，${error instanceof Error ? error.message : String(error)}`)
  }
}
