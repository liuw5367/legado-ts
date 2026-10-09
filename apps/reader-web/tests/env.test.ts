import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const appDirectory = new URL('../', import.meta.url)
const envLoader = pathToFileURL(new URL('../server/env.ts', import.meta.url).pathname).href

test('server env loader reads the configured local environment file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'legado-reader-env-'))
  const envFile = join(directory, '.env.local')
  writeFileSync(envFile, 'READER_WEB_ENV_TEST=loaded\n')
  try {
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import '${envLoader}' ; console.log(process.env.READER_WEB_ENV_TEST ?? '')`], {
      cwd: new URL('.', appDirectory).pathname,
      env: { ...process.env, READER_WEB_ENV_FILE: envFile },
      encoding: 'utf8',
    }).trim()
    assert.equal(output, 'loaded')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
