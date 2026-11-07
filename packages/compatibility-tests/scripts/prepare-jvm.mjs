import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { root, readJson, sha256, stable, git, treeHash } from './common.mjs'

async function artifactsHash(directory) {
  const classpath = (await readFile(join(directory, 'classpath.txt'), 'utf8')).trim()
  const jars = []
  for (const path of classpath.split(':')) jars.push(sha256(await readFile(path)))
  return sha256(stable([await treeHash(join(directory, 'classes')), classpath, jars]))
}
export async function prepare(upstream) {
  const lock = await readJson(join(root, 'reference-sources.json'))
  const sourceRoot = resolve(upstream ?? join(root, '../../..'))
  const directory = join(root, 'jvm/target')
  await mkdir(directory, { recursive: true })
  await rm(join(directory, 'reference'), { recursive: true, force: true })
  const manifest = []
  for (const entry of lock.files) {
    const text = git(sourceRoot, 'show', `${lock.commit}:${entry.path}`)
    if (sha256(text) !== entry.sha256) throw new Error(`参考源码摘要变化: ${entry.path}`)
    const destination = join(directory, 'reference', entry.path)
    await mkdir(resolve(destination, '..'), { recursive: true })
    await writeFile(destination, text)
    manifest.push(entry)
  }
  const versions = git(sourceRoot, 'show', `${lock.commit}:gradle/libs.versions.toml`)
  for (const [key, version] of Object.entries(lock.versions)) {
    if (!versions.split('\n').some((line) => line.trim() === `${key} = "${version}"`)) throw new Error(`上游版本不匹配: ${key}`)
  }
  const javaHome = process.env.JAVA_HOME ?? '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
  const java = join(javaHome, 'bin/java')
  await access(java)
  const jvmHash = await treeHash(join(root, 'jvm'))
  const fingerprint = sha256(stable({ lock, jvmHash, javaHome }))
  const metadataPath = join(directory, 'build.json')
  try {
    const old = await readJson(metadataPath)
    await access(join(directory, 'classes/compat/MainKt.class'))
    await access(join(directory, 'classpath.txt'))
    if (old.fingerprint === fingerprint && old.artifactsHash === await artifactsHash(directory)) return { ...old, java }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await rm(join(directory, 'classes'), { recursive: true, force: true })
  console.log('编译纯 JVM 参考端（首次下载依赖，日志位于 jvm/target/build.log）')
  const args = ['-B', '-ntp', '-s', join(root, 'jvm/settings.xml'), '-f', join(root, 'jvm/pom.xml'), `-Dmaven.repo.local=${join(directory, 'm2')}`, ...Object.entries(lock.versions).map(([key, value]) => `-D${key}.version=${value}`), 'compile', 'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath', `-Dmdep.outputFile=${join(directory, 'classpath.txt')}`]
  const log = []
  await new Promise((done, reject) => {
    const child = spawn('mvn', args, { cwd: root, env: { ...process.env, JAVA_HOME: javaHome } })
    child.stdout.on('data', (data) => log.push(data))
    child.stderr.on('data', (data) => log.push(data))
    const heartbeat = setInterval(() => console.log('JVM 构建仍在进行…'), 30_000)
    child.on('error', (error) => { clearInterval(heartbeat); reject(error) })
    child.on('close', async (code) => {
      clearInterval(heartbeat)
      await writeFile(join(directory, 'build.log'), Buffer.concat(log))
      if (code === 0) done()
      else reject(new Error(`Maven 构建失败 (${code})，查看 ${join(directory, 'build.log')}`))
    })
  })
  const metadata = { fingerprint, artifactsHash: await artifactsHash(directory), commit: lock.commit, sources: manifest, adaptations: lock.adaptations, versions: lock.versions, jvmHash, javaHome }
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n')
  return { ...metadata, java }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args[0] !== '--upstream' || args.length !== 2)) throw new Error('用法: prepare:jvm [--upstream <本地上游目录>]')
    console.log(JSON.stringify(await prepare(args[1]), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 2 }
}
