import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const sourceRoot = resolve(import.meta.dirname, '../src')

test('shadcn component aliases resolve to shared primitives used by pages', async () => {
  const config = JSON.parse(await readFile(resolve(import.meta.dirname, '../components.json'), 'utf8')) as { aliases?: { ui?: string; utils?: string } }
  assert.equal(config.aliases?.ui, '@/components/ui')
  assert.equal(config.aliases?.utils, '@/lib/utils')
  for (const component of ['button', 'card', 'input', 'select', 'badge']) {
    const source = await readFile(resolve(sourceRoot, `components/ui/${component}.tsx`), 'utf8')
    assert.match(source, /export function/u)
  }
  for (const component of ['book-cover', 'reader-layout', 'reader-settings-panel', 'ui/sheet']) {
    const source = await readFile(resolve(sourceRoot, `components/${component}.tsx`), 'utf8')
    assert.match(source, /export function/u)
  }
  const sheet = await readFile(resolve(sourceRoot, 'components/ui/sheet.tsx'), 'utf8')
  const readerSettingsPanel = await readFile(resolve(sourceRoot, 'components/reader-settings-panel.tsx'), 'utf8')
  const sharedMenu = await readFile(resolve(sourceRoot, 'components/more-menu.tsx'), 'utf8')
  const accountHome = await readFile(resolve(sourceRoot, 'pages/account-home.tsx'), 'utf8')
  const readerPage = await readFile(resolve(sourceRoot, 'pages/reader.tsx'), 'utf8')
  const settingsPage = await readFile(resolve(sourceRoot, 'pages/settings.tsx'), 'utf8')
  const router = await readFile(resolve(sourceRoot, 'router.tsx'), 'utf8')
  const sourcesPage = await readFile(resolve(sourceRoot, 'pages/sources.tsx'), 'utf8')
  const readingSettingsPage = await readFile(resolve(sourceRoot, 'pages/reading-settings.tsx'), 'utf8')
  const authForm = await readFile(resolve(sourceRoot, 'components/auth-form.tsx'), 'utf8')
  assert.match(sharedMenu, /pointerdown/u)
  assert.match(sharedMenu, /Escape/u)
  assert.match(accountHome, /<MoreMenu/u)
  assert.match(readerPage, /<MoreMenu/u)
  assert.doesNotMatch(readerPage, /ReaderMoreMenu/u)
  assert.match(settingsPage, /settings-entry-list/u)
  assert.match(settingsPage, /settings-logout-button/u)
  assert.match(router, /account\/settings\/reading/u)
  assert.match(sourcesPage, /<PageBackButton fallback="\/account\/settings" \/>/u)
  assert.match(sourcesPage, /<Button size="sm" type="button"/u)
  assert.doesNotMatch(sourcesPage, /返回设置/u)
  assert.match(authForm, /backTo\?: string/u)
  assert.match(readingSettingsPage, /className="toc-heading"/u)
  assert.match(readingSettingsPage, /className="toc-heading-main"/u)
  assert.match(sheet, /event\.target === event\.currentTarget/u)
  assert.doesNotMatch(readerSettingsPanel, /已保存/u)
  assert.match(readerPage, /reader-toc-utility-actions/u)
  assert.match(readerPage, />完整目录<\/Link>/u)
  assert.doesNotMatch(readerPage, /打开完整目录/u)
  assert.match(readerPage, /刷新目录数据/u)
  const pageSources = await Promise.all(['components/auth-form.tsx', 'pages/register.tsx', 'pages/forgot-password.tsx', 'pages/change-password.tsx', 'pages/reset-password.tsx', 'pages/search.tsx', 'pages/book-sources.tsx', 'pages/toc.tsx', 'pages/settings.tsx', 'pages/account-home.tsx'].map((file) => readFile(resolve(sourceRoot, file), 'utf8')))
  for (const source of pageSources) assert.match(source, /(?:components\/ui\/|\.\/ui\/)/u)
  for (const source of [pageSources[2], pageSources[3], pageSources[4]]) { assert.match(source ?? '', /backTo=/u); assert.doesNotMatch(source ?? '', /footer=/u) }
  assert.match(pageSources[7] ?? '', /className="toc-check"/u)
  const searchPage = await readFile(resolve(sourceRoot, 'pages/search.tsx'), 'utf8')
  const styles = await readFile(resolve(sourceRoot, 'styles.css'), 'utf8')
  assert.match(styles, /\.reader-toc-actions \{[^}]*justify-content: space-between/u)
  assert.doesNotMatch(styles, /\.reader-toc-actions \{ flex-direction: column/u)
  assert.match(styles, /\.reader-html-content \{[^}]*white-space: pre-wrap/u)
  assert.match(sourcesPage, /source-status/u)
  assert.match(sourcesPage, /已启用/u)
  assert.match(sourcesPage, /已禁用/u)
  assert.doesNotMatch(sourcesPage, /saveOrder|source-order-field|onOrder/u)
  assert.match(searchPage, /precision/u)
  assert.match(searchPage, /cancel-button-active/u)
  assert.match(pageSources[6] ?? '', /cancel-button-active/u)
  assert.doesNotMatch(searchPage, /\/api\/sources/u)
  assert.doesNotMatch(searchPage, /sourceIds/u)
})
