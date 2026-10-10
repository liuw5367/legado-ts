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
  const pageSources = await Promise.all(['components/auth-form.tsx', 'pages/register.tsx', 'pages/forgot-password.tsx', 'pages/change-password.tsx', 'pages/reset-password.tsx', 'pages/search.tsx', 'pages/toc.tsx', 'pages/settings.tsx', 'pages/account-home.tsx'].map((file) => readFile(resolve(sourceRoot, file), 'utf8')))
  for (const source of pageSources) assert.match(source, /(?:components\/ui\/|\.\/ui\/)/u)
  const searchPage = await readFile(resolve(sourceRoot, 'pages/search.tsx'), 'utf8')
  assert.match(searchPage, /precision/u)
  assert.doesNotMatch(searchPage, /\/api\/sources/u)
  assert.doesNotMatch(searchPage, /sourceIds/u)
})
