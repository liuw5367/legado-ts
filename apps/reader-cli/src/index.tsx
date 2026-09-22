#!/usr/bin/env node
import React from 'react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, Text } from 'ink'
import { parseReaderArgs, cliHelp } from './config.ts'
import { loadSourceCatalog } from './source-catalog.ts'
import { ReaderStorage } from './storage.ts'
import { ReaderApplication } from './application.ts'
import { ReaderUi } from './ui.tsx'

export const version = '0.1.0'

export async function main(args: readonly string[] = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config
  try {
    config = parseReaderArgs(args, environment)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (config.help) { process.stdout.write(cliHelp); return 0 }
  if (config.version) { process.stdout.write(`${version}\n`); return 0 }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('legado-reader 需要交互式 TTY；--help 和 --version 可以在非 TTY 环境使用。\n')
    return 2
  }
  const storage = new ReaderStorage()
  try {
    await storage.initialize()
    const catalog = await loadSourceCatalog(config.source, { storage })
    const application = new ReaderApplication({ catalog, storage })
    const instance = render(<ReaderUi application={application} catalog={catalog} />, { exitOnCtrlC: false, alternateScreen: true })
    await new Promise<void>((resolve) => instance.waitUntilExit().then(() => resolve()))
    await application.close()
    return 0
  } catch (error) {
    await storage.close().catch(() => undefined)
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  void main().then((code) => { if (code !== 0) process.exitCode = code })
}

export function UsageError(): React.ReactElement {
  return <Text>{cliHelp}</Text>
}
