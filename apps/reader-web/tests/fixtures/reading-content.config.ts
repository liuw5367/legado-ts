import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { normalizeReadingContent } from '@legado/source-core'
import { parseReadingHtml } from '@legado/source-node'
import { readingContentCases } from '../../../../packages/source-core/tests/fixtures/reading-content.ts'

export default defineConfig({
  plugins: [pluginReact()],
  source: { entry: { index: './tests/fixtures/reading-content.browser.tsx' }, define: { __NODE_READING_DOCS__: JSON.stringify(readingContentCases.map((fixture) => normalizeReadingContent(fixture.input, parseReadingHtml))) } },
  html: { title: '统一正文浏览器验收' },
  server: { host: '127.0.0.1', port: 3001, open: false },
  output: { distPath: { root: '/tmp/legado-reading-content-browser' } },
})
