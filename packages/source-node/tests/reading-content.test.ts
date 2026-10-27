import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReadingContent, readingParagraphTexts } from '../../source-core/src/reading/content.ts'
import { readingContentCases } from '../../source-core/tests/fixtures/reading-content.ts'
import { parseReadingHtml } from '../src/html.ts'

for (const fixture of readingContentCases) test(fixture.name, () => {
  const document = normalizeReadingContent(fixture.input, parseReadingHtml)
  assert.deepEqual(readingParagraphTexts(document), fixture.texts)
  assert.deepEqual(document.blocks.map((block) => block.kind), fixture.kinds)
})
