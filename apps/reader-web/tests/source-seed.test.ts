import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { MemoryReaderRepository } from '../server/db/repository.ts'
import { resetSourceSeedForTests, seedConfiguredSources } from '../server/db/source-seed.ts'

test('web source seed loads a deployment-owned directory without JSON env input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legado-reader-sources-'))
  const previousDirectory = process.env.READER_SOURCES_DIR
  const previousJson = process.env.READER_SOURCES_JSON
  try {
    await writeFile(join(root, 'sources.json'), JSON.stringify([{ bookSourceUrl: 'https://seed.test', bookSourceName: '目录书源', bookSourceType: 0, enabled: true, customOrder: 3, searchUrl: 'https://seed.test/search?key={{key}}', ruleSearch: {}, ruleBookInfo: {}, ruleToc: {}, ruleContent: {} }]), 'utf8')
    process.env.READER_SOURCES_DIR = root
    process.env.READER_SOURCES_JSON = '{not-used-by-web-seed'
    resetSourceSeedForTests()
    const repository = new MemoryReaderRepository()
    await seedConfiguredSources(repository)
    const sources = await repository.listSources()
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.sourceId, 'https://seed.test')
    assert.equal(sources[0]?.name, '目录书源')
  } finally {
    if (previousDirectory === undefined) delete process.env.READER_SOURCES_DIR
    else process.env.READER_SOURCES_DIR = previousDirectory
    if (previousJson === undefined) delete process.env.READER_SOURCES_JSON
    else process.env.READER_SOURCES_JSON = previousJson
    resetSourceSeedForTests()
    await rm(root, { recursive: true, force: true })
  }
})
