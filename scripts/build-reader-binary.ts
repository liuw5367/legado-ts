import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

const MAX_FILES = 256
const MAX_BYTES = 4 * 1024 * 1024
const sourceExtensions = new Set(['.json', '.js'])

interface BinaryBuildOptions {
  sourceDir?: string
  outfile: string
  target?: string
}

interface EmbeddedSourceInput {
  text: string
  location: string
}

interface BuildResolveArgs {
  importer: string
}

interface BuildLoadArgs {
  path: string
}

interface BuildPluginApi {
  onResolve(options: { filter: RegExp }, callback: (args: BuildResolveArgs) => { path: string; namespace?: string } | undefined): void
  onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: BuildLoadArgs) => { contents: string; loader: 'js' } | Promise<{ contents: string; loader: 'js' }>): void
}

interface BuildResult {
  success: boolean
  logs: readonly { message?: unknown }[]
}

interface EmbeddedSourceBundle {
  path?: string
}

declare const Bun: {
  build(options: {
    entrypoints: readonly string[]
    target: string
    compile: { outfile: string }
    minify: boolean
    plugins: readonly { name: string; setup(build: BuildPluginApi): void }[]
  }): Promise<BuildResult>
  file(path: string): { text(): Promise<string> }
}

async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(helpText)
    return 0
  }
  let options: BinaryBuildOptions
  try {
    options = parseArgs(args)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  let sources: EmbeddedSourceInput[] = []
  try {
    if (options.sourceDir !== undefined) sources = await collectSources(options.sourceDir)
    await mkdir(dirname(options.outfile), { recursive: true })
    const tempRoot = await mkdtemp(join(tmpdir(), 'legado-reader-binary-'))
    try {
      const entrypoint = join(tempRoot, 'entry.ts')
      const sourceBundle = await writeEmbeddedSourceBundle(tempRoot, sources)
      await writeFile(entrypoint, createEntrypoint(sourceBundle.path), 'utf8')
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target: options.target ?? 'bun',
        compile: { outfile: options.outfile },
        minify: true,
        plugins: [quickJsReleaseOnlyPlugin(), quickJsWasmPlugin(), reactDevtoolsPlugin()],
      })
      if (!result.success) throw new Error(result.logs.map((log) => String(log.message ?? log)).join('\n'))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  } catch (error) {
    process.stderr.write(`二进制构建失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const sourceSummary = sources.length === 0 ? '不含内置书源' : `内置 ${sources.length} 个书源文件`
  process.stdout.write(`已生成 ${options.outfile}（${sourceSummary}）\n`)
  return 0
}

function parseArgs(args: readonly string[]): BinaryBuildOptions {
  let sourceDir: string | undefined
  let outfile = resolve('dist/legado-reader')
  let target: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--help' || argument === '-h') continue
    const [name, inlineValue] = argument.split('=', 2)
    if (name === '--source-dir') {
      sourceDir = inlineValue ?? requireValue(args, ++index, '--source-dir')
      continue
    }
    if (name === '--outfile') {
      outfile = resolve(inlineValue ?? requireValue(args, ++index, '--outfile'))
      continue
    }
    if (name === '--target') {
      target = inlineValue ?? requireValue(args, ++index, '--target')
      continue
    }
    if (argument.startsWith('-')) throw new Error(`未知构建参数：${argument}\n\n${helpText}`)
    throw new Error(`不支持位置参数：${argument}\n\n${helpText}`)
  }
  return { ...(sourceDir === undefined ? {} : { sourceDir: resolve(sourceDir) }), outfile, ...(target === undefined ? {} : { target }) }
}

function requireValue(args: readonly string[], index: number, name: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('-')) throw new Error(`${name} 需要一个值`)
  return value
}

async function collectSources(directory: string): Promise<EmbeddedSourceInput[]> {
  const info = await lstat(directory).catch(() => undefined)
  if (info === undefined) throw new Error(`内置书源目录不存在：${directory}`)
  if (info.isSymbolicLink()) throw new Error(`内置书源目录不能是符号链接：${directory}`)
  if (!info.isDirectory()) throw new Error(`内置书源路径不是目录：${directory}`)

  const files: string[] = []
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await visit(child)
        continue
      }
      if (!entry.isFile() || !sourceExtensions.has(extname(entry.name).toLowerCase())) continue
      files.push(child)
      if (files.length > MAX_FILES) throw new Error(`内置书源文件超过上限 ${MAX_FILES}`)
    }
  }
  await visit(directory)
  if (files.length === 0) throw new Error(`内置书源目录没有 .json 或 .js 文件：${directory}`)

  let totalBytes = 0
  const sources: EmbeddedSourceInput[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    const bytes = new TextEncoder().encode(text).byteLength
    if (bytes > MAX_BYTES) throw new Error(`内置书源文件超过 ${MAX_BYTES} 字节：${file}`)
    totalBytes += bytes
    const location = relative(directory, file).split(sep).join('/')
    sources.push({ text, location: `builtin:${location}` })
  }
  process.stdout.write(`读取 ${files.length} 个内置书源文件，共 ${totalBytes} 字节\n`)
  return sources
}

async function writeEmbeddedSourceBundle(tempRoot: string, sources: readonly EmbeddedSourceInput[]): Promise<EmbeddedSourceBundle> {
  if (sources.length === 0) return {}
  const payload = Buffer.from(JSON.stringify(sources), 'utf8')
  const compressed = brotliCompressSync(payload, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  })
  const path = join(tempRoot, 'embedded-sources.br')
  await writeFile(path, compressed)
  process.stdout.write(`压缩内置书源：${payload.byteLength} -> ${compressed.byteLength} 字节\n`)
  return { path }
}

function createEntrypoint(embeddedSourcePath?: string): string {
  const sourceModule = JSON.stringify(resolve('apps/reader-cli/src/embedded-sources.ts'))
  const mainModule = JSON.stringify(resolve('apps/reader-cli/src/index.tsx'))
  const lines = [
    `import { setEmbeddedSourceInputs } from ${sourceModule}`,
  ]
  if (embeddedSourcePath !== undefined) {
    lines.push(
      'import { brotliDecompressSync } from "node:zlib"',
      `import embeddedSourcePath from ${JSON.stringify(embeddedSourcePath)} with { type: "file" }`,
      'const embeddedSourceBytes = new Uint8Array(await Bun.file(embeddedSourcePath).arrayBuffer())',
      'const embeddedSourceText = new TextDecoder().decode(brotliDecompressSync(embeddedSourceBytes))',
      'setEmbeddedSourceInputs(JSON.parse(embeddedSourceText))',
    )
  }
  lines.push(
    'globalThis.__LEGADO_READER_MANUAL_ENTRY__ = true',
    `const { main } = await import(${mainModule})`,
    'const code = await main()',
    'if (code !== 0) process.exitCode = code',
    '',
  )
  return lines.join('\n')
}

function quickJsWasmPlugin() {
  return {
    name: 'legado-embed-quickjs-wasm',
    setup(build: BuildPluginApi): void {
      build.onResolve({ filter: /^@jitl\/quickjs-wasmfile-(?:debug|release)-(?:asyncify|sync)\/emscripten-module$/ }, (args) => ({ path: join(dirname(args.importer), 'emscripten-module.mjs') }))
      build.onLoad({ filter: /quickjs-wasmfile-(?:debug|release)-(?:asyncify|sync)[/]dist[/]emscripten-module[.]mjs$/ }, async (args) => {
        const source = await Bun.file(args.path).text()
        const marker = 'export default QuickJSRaw;'
        if (!source.includes(marker)) throw new Error(`无法包装 QuickJS WASM 加载器：${args.path}`)
        const replacement = 'import wasmPath from "./emscripten-module.wasm" with { type: "file" };\nconst __legadoQuickJSRaw = QuickJSRaw;\nasync function QuickJSEmbedded(moduleArg = {}) { return __legadoQuickJSRaw({ ...moduleArg, wasmBinary: await Bun.file(wasmPath).arrayBuffer() }); }\nexport default QuickJSEmbedded;'
        return { contents: source.replace(marker, replacement), loader: 'js' }
      })
    },
  }
}

function quickJsReleaseOnlyPlugin() {
  const nodeRequire = createRequire(import.meta.url)
  const sourceNodeRoot = resolve('packages/source-node')
  const quickJsRoot = resolvePackageRoot(nodeRequire, 'quickjs-emscripten', sourceNodeRoot)
  const quickJsCoreRoot = resolvePackageRoot(nodeRequire, 'quickjs-emscripten-core', quickJsRoot)
  const releaseAsyncRoot = resolvePackageRoot(nodeRequire, '@jitl/quickjs-wasmfile-release-asyncify', quickJsRoot)
  const facade = [
    `import { DefaultIntrinsics, newQuickJSAsyncWASMModuleFromVariant } from ${JSON.stringify(join(quickJsCoreRoot, 'dist/index.mjs'))}`,
    `import RELEASE_ASYNC from ${JSON.stringify(join(releaseAsyncRoot, 'dist/index.mjs'))}`,
    'export { DefaultIntrinsics }',
    'export async function newAsyncContext(options) { return (await newQuickJSAsyncWASMModuleFromVariant(RELEASE_ASYNC)).newContext(options) }',
    '',
  ].join('\n')
  return {
    name: 'legado-release-only-quickjs',
    setup(build: BuildPluginApi): void {
      build.onResolve({ filter: /^quickjs-emscripten$/ }, () => ({ path: 'quickjs-emscripten', namespace: 'legado-quickjs' }))
      build.onLoad({ filter: /^quickjs-emscripten$/, namespace: 'legado-quickjs' }, () => ({ contents: facade, loader: 'js' }))
    },
  }
}

function resolvePackageRoot(nodeRequire: ReturnType<typeof createRequire>, packageName: string, from: string): string {
  return dirname(nodeRequire.resolve(`${packageName}/package.json`, { paths: [from] }))
}

function reactDevtoolsPlugin() {
  return {
    name: 'legado-stub-react-devtools',
    setup(build: BuildPluginApi): void {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'legado-devtools' }))
      build.onLoad({ filter: /.*/, namespace: 'legado-devtools' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} }', loader: 'js' }))
    },
  }
}

const helpText = `Bun 单文件构建：

  pnpm build:binary --source-dir <目录>

参数：
  --source-dir <目录>  将目录中的 .json/.js 书源递归嵌入二进制
  --outfile <路径>     输出路径，默认 dist/legado-reader
  --target <目标>      Bun 目标平台，例如 bun-linux-x64
`

const code = await main()
if (code !== 0) process.exitCode = code
