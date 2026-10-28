import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { DEFAULT_READER_SETTINGS } from '../server/domain/types.ts'
import { DEFAULT_PAGE_TAP_ZONES } from '../src/lib/api.ts'

const code = ts.transpileModule(readFileSync(new URL('../src/lib/settings-context.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setup() {
  let auth = { user: { id: 'a' }, session: {} }; let cursor = 0
  const slots: any[] = [], effects: Array<() => void> = [], requests: Array<ReturnType<typeof deferred<{ settings: any }>>> = []
  const storage = new Map<string, string>()
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const memo = (create: () => unknown, deps: unknown[]) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: create(), deps }; return slots[i].value }
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
    useRef: (value: unknown) => { const i = cursor++; return slots[i] ?? (slots[i] = { current: value }) },
    useMemo: memo, useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const previous = slots[i]; slots[i] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = effect() }) } },
  }
  const module = { exports: {} as { ReaderSettingsProvider: (props: unknown) => { props: { value: any } } } }
  runInNewContext(code, {
    module, exports: module.exports, console, Date, Map, Object, Promise,
    window: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} },
    document: { documentElement: { dataset: {}, style: {} }, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    require: (name: string) => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }) }
      if (name.includes('auth-context')) return { useAuth: () => auth }
      if (name.includes('search-settings')) return { DEFAULT_SEARCH_CONCURRENCY: 8, searchConcurrencySchema: { catch: () => ({ parse: (value: unknown) => value ?? 8 }) } }
      if (name.includes('api.ts')) return { DEFAULT_PAGE_TAP_ZONES, apiFetch: () => { const request = deferred<{ settings: any }>(); requests.push(request); return request.promise } }
      if (name.includes('reader-pagination')) return { normalizePageTapZones: () => DEFAULT_PAGE_TAP_ZONES }
      if (name.includes('settings-save-queue')) return { SettingsSaveQueue: class { hasFailed = false; resume() {} dispose() {} flush() { return Promise.resolve(undefined) } enqueue() { return new Promise(() => {}) } } }
      return {}
    },
  })
  const render = () => { cursor = 0; const value = module.exports.ReaderSettingsProvider({ children: null }).props.value; while (effects.length) effects.shift()!(); return value }
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); return render() }
  const settings = (id: string, initial = 'all') => ({ ...DEFAULT_READER_SETTINGS, userId: id, general: { ...DEFAULT_READER_SETTINGS.general, bookshelfInitialGroup: initial }, updatedAt: '' })
  return { render, settle, requests, settings, switchUser: (id: string) => { auth = { user: { id }, session: {} } } }
}

test('账号设置延迟与失败重试有明确状态，重试不会覆盖尚未保存的预览', async () => {
  const h = setup(); assert.equal(h.render().settingsLoadStatus, 'loading')
  h.requests[0]!.reject(new Error('模拟失败'))
  let value = await h.settle(); assert.equal(value.settingsLoadStatus, 'error')
  void value.retrySettingsLoad(); value = h.render(); assert.equal(value.settingsLoadStatus, 'loading')
  void value.updateSettings({ fontSize: 25 })
  h.requests[1]!.resolve({ settings: h.settings('a', '远端分组') })
  value = await h.settle()
  assert.equal(value.settingsLoadStatus, 'ready'); assert.equal(value.settings.fontSize, 25)
  assert.equal(value.settings.general.bookshelfInitialGroup, '远端分组')
})

test('账号切换立即回到加载状态，旧账号迟到响应不能初始化新账号', async () => {
  const h = setup(); h.render(); h.switchUser('b')
  assert.equal(h.render().settingsLoadStatus, 'loading')
  h.requests[0]!.resolve({ settings: h.settings('a', '旧账号分组') })
  let value = await h.settle(); assert.equal(value.settingsLoadStatus, 'loading')
  assert.notEqual(value.settings.general.bookshelfInitialGroup, '旧账号分组')
  h.requests[1]!.resolve({ settings: h.settings('b', '新账号分组') })
  value = await h.settle(); assert.equal(value.settingsLoadStatus, 'ready'); assert.equal(value.settings.userId, 'b')
  assert.equal(value.settings.general.bookshelfInitialGroup, '新账号分组')
})
