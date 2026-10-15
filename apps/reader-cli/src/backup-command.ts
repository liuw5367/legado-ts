import { access, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { BACKUP_CATEGORIES, readBackupZip, type BackupCategory } from '@legado/reader-backup'
import { ReaderStorage } from './storage.ts'
import type { BackupCommand } from './config.ts'

export async function runBackupCommand(command: BackupCommand, streams: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; error?: NodeJS.WritableStream } = {}): Promise<number> {
  const stdout = streams.output ?? output
  const stderr = streams.error ?? process.stderr
  if (command.action === 'export') return exportBackup(command.path, stdout, stderr)
  return importBackup(command, streams.input ?? input, stdout, stderr)
}

async function exportBackup(path: string, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): Promise<number> {
  if (await exists(path)) { stderr.write(`目标文件已存在：${path}\n`); return 2 }
  const storage = new ReaderStorage()
  try {
    await storage.initialize()
    const zip = await storage.createBackupZip('reader-cli')
    await writeFile(path, zip, { flag: 'wx', mode: 0o600 })
    stdout.write(`已导出用户数据：${path}（${zip.byteLength} 字节）\n`)
    return 0
  } finally {
    await storage.close().catch(() => undefined)
  }
}

async function importBackup(command: BackupCommand, input: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): Promise<number> {
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(await readFile(command.path)) } catch (error) { stderr.write(`无法读取备份：${message(error)}\n`); return 2 }
  let archive
  try { archive = await readBackupZip(bytes) } catch (error) { stderr.write(`备份校验失败：${message(error)}\n`); return 2 }
  const categories = command.categories ?? [...BACKUP_CATEGORIES]
  stdout.write(`备份创建于 ${archive.manifest.createdAt}，共 ${archive.files.size - 1} 个文件。\n`)
  stdout.write(`将覆盖：${categories.map(categoryLabel).join('、')}。\n`)
  stdout.write(`数据数量：书架 ${archive.manifest.counts.bookshelf}，阅读 ${archive.manifest.counts.reading}，搜索 ${archive.manifest.counts.search}，书源 ${archive.manifest.counts.sources}，设置 ${archive.manifest.counts.settings}。\n`)
  if (!command.yes) {
    if (!isTty(input, stdout)) { stderr.write('非交互环境必须使用 --yes；当前未写入任何数据。\n'); return 2 }
    const readline = createInterface({ input: input as NodeJS.ReadableStream & { [Symbol.asyncIterator](): AsyncIterableIterator<string> }, output: stdout as NodeJS.WritableStream })
    try {
      const answer = await readline.question('确认覆盖所选数据？输入 yes 继续：')
      if (answer.trim().toLocaleLowerCase() !== 'yes') { stdout.write('已取消导入，未写入任何数据。\n'); return 0 }
    } finally { readline.close() }
  }
  const storage = new ReaderStorage()
  try {
    await storage.initialize()
    await storage.restoreBackup(bytes, categories)
    stdout.write('导入完成。\n')
    return 0
  } catch (error) {
    stderr.write(`导入失败：${message(error)}\n`)
    return 1
  } finally {
    await storage.close().catch(() => undefined)
  }
}

function isTty(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): boolean { return (input as NodeJS.ReadStream).isTTY === true && (output as NodeJS.WriteStream).isTTY === true }
function categoryLabel(category: BackupCategory): string { return ({ bookshelf: '书架', reading: '阅读记录', search: '搜索记录', sources: '书源', settings: '设置' })[category] }
async function exists(path: string): Promise<boolean> { try { await access(path); return true } catch { return false } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
