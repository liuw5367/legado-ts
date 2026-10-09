import assert from 'node:assert/strict'
import test from 'node:test'
import { findNavigationFrameIndex, navigateNavigationFrame, navigationKey, navigationModeForPage, popNavigationFrame, popToNavigationFrame, previousNavigationFrame, type NavigationRequest } from '../src/navigation.ts'
import type { NavigationFrame } from '../src/ui-model.ts'

interface TestFrame extends NavigationFrame {
  marker: string
}

const home: TestFrame = { page: 'home', selected: 0, listStart: 0, pageScroll: 0, homeArea: 0, query: '', readerLine: 0, marker: 'home' }

function frame(page: NavigationFrame['page'], marker: string, extra: Partial<NavigationFrame> = {}): TestFrame {
  return { ...home, page, marker, ...extra }
}

function request(mode: NavigationRequest<TestFrame>['mode'], key: string): NavigationRequest<TestFrame> {
  return { mode, key, keyOf: (item) => item.navigationKey ?? (item.page === 'reader' ? navigationKey(item.page, item.bookId, item.editionKey) : navigationKey(item.page)) }
}

test('standard 按进入顺序压栈，返回只弹出当前页面', () => {
  const search = frame('search', 'search')
  const results = frame('results', 'results')
  const stack = navigateNavigationFrame(navigateNavigationFrame([home], search, request('standard', navigationKey('search'))), results, request('standard', navigationKey('results')))
  assert.deepEqual(stack.map((item) => item.page), ['home', 'search', 'results'])
  assert.equal(previousNavigationFrame(stack)?.page, 'search')
  assert.equal(popNavigationFrame(stack).at(-1)?.page, 'search')
})

test('singleTop 复用栈顶，singleTask 清理目标页上方并消除旧重复实例', () => {
  const firstDiagnostics = frame('diagnostics', 'diagnostics-1')
  const detail = frame('detail', 'detail')
  const secondDiagnostics = frame('diagnostics', 'diagnostics-2')
  const topReused = navigateNavigationFrame([home, firstDiagnostics], secondDiagnostics, request('singleTop', navigationKey('diagnostics')))
  assert.deepEqual(topReused.map((item) => item.marker), ['home', 'diagnostics-2'])

  const duplicateDiagnostics = frame('diagnostics', 'diagnostics-old')
  const nextDetail = frame('detail', 'detail-2')
  const reopened = navigateNavigationFrame([home, duplicateDiagnostics, detail, nextDetail], frame('diagnostics', 'diagnostics-new'), request('singleTask', navigationKey('diagnostics')))
  assert.deepEqual(reopened.map((item) => item.marker), ['home', 'diagnostics-new'])
})

test('replace 不增加栈深度，popTo 可以更新已有页面并移除其上方页面', () => {
  const mapping = frame('mapping', 'mapping')
  const toc = frame('toc', 'toc')
  const replaced = navigateNavigationFrame([home, mapping], toc, request('replace', navigationKey('toc')))
  assert.deepEqual(replaced.map((item) => item.page), ['home', 'toc'])

  const reader = frame('reader', 'reader-old', { bookId: 'book', editionKey: 'edition' })
  const detail = frame('detail', 'detail')
  const updated = popToNavigationFrame([home, reader, detail], navigationKey('reader', 'book', 'edition'), (item) => item.navigationKey ?? (item.page === 'reader' ? navigationKey(item.page, item.bookId, item.editionKey) : navigationKey(item.page)), (item) => ({ ...item, marker: 'reader-updated', readerLine: 9 }))
  assert.deepEqual(updated.map((item) => item.marker), ['home', 'reader-updated'])
  assert.equal(updated.at(-1)?.readerLine, 9)
})

test('导航身份区分不同书籍版本，并能找到最近的目标实例', () => {
  const readerA = frame('reader', 'reader-a', { bookId: 'book-a', editionKey: 'edition-a' })
  const readerB = frame('reader', 'reader-b', { bookId: 'book-b', editionKey: 'edition-b' })
  const stack = [home, readerA, readerB]
  const keyOf = (item: TestFrame): string => navigationKey(item.page, item.bookId, item.editionKey)
  assert.equal(findNavigationFrameIndex(stack, navigationKey('reader', 'book-a', 'edition-a'), keyOf), 1)
  assert.equal(findNavigationFrameIndex(stack, navigationKey('reader', 'book-c', 'edition-c'), keyOf), -1)
})

test('页面策略把工具页设为单例，把内容页保留为普通实例', () => {
  assert.equal(navigationModeForPage('settings'), 'singleTask')
  assert.equal(navigationModeForPage('diagnostics'), 'singleTask')
  assert.equal(navigationModeForPage('reader'), 'singleTop')
  assert.equal(navigationModeForPage('detail'), 'standard')
  assert.equal(navigationModeForPage('mapping'), 'standard')
})
