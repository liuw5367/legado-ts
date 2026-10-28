import { DEFAULT_SEARCH_CONCURRENCY, searchConcurrencySchema } from '../../shared/search-settings.ts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './auth-context.tsx'
import { apiFetch, DEFAULT_PAGE_TAP_ZONES, type ApiReadingMode, type ApiSettings, type ApiThemeMode } from './api.ts'
import { normalizePageTapZones } from './reader-pagination.ts'
import { Select } from '../components/ui/select.tsx'
import { SettingsSaveQueue, type SettingsPatch } from './settings-save-queue.ts'

export const DEFAULT_SETTINGS: Omit<ApiSettings, 'userId' | 'updatedAt'> = { theme: 'system', readingMode: 'scroll', fontSize: 18, lineHeight: 1.9, marginTop: 16, marginRight: 16, marginBottom: 16, marginLeft: 16, general: { searchConcurrency: DEFAULT_SEARCH_CONCURRENCY, bookshelfSort: 'addedAt', bookshelfInitialGroup: 'all' }, pageTapZones: DEFAULT_PAGE_TAP_ZONES }
type UpdateSettingsOptions = { optimistic?: boolean; debounce?: boolean }
type LocalSettingsSnapshot = Partial<ApiSettings> & { schemaVersion?: number }
interface ReaderSettingsContextValue { settingsLoadStatus: 'loading' | 'ready' | 'error'; retrySettingsLoad: () => Promise<void>; settings: ApiSettings; resolvedTheme: 'light' | 'dark'; saving: boolean; canRetrySettings: boolean; error?: string; updateSettings: (patch: SettingsPatch, options?: UpdateSettingsOptions) => Promise<ApiSettings>; flushSettings: (retry?: boolean) => Promise<void> }
const ReaderSettingsContext = createContext<ReaderSettingsContextValue | undefined>(undefined)
const storagePrefix = 'legado-reader-settings:'
const themeColors: Record<'light' | 'dark', string> = { light: '#f6f3ed', dark: '#171513' }

export function ReaderSettingsProvider({ children }: { children: ReactNode }) {
  const { session, user } = useAuth()
  const [settings, setSettings] = useState<ApiSettings>(() => readLocalSettings(undefined))
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme('system'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const latestSettings = useRef(settings)
  const changeSequence = useRef(0)
  const fieldVersions = useRef(new Map<string, number>())
  const userId = user?.id
  const authenticated = session !== null
  const owner = useMemo(() => ({ count: 0, queue: new SettingsSaveQueue(async (patch) => {
    const result = await apiFetch<{ settings: ApiSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }, userId)
    return result.settings
  }) }), [userId, authenticated])
  const activeOwner = useRef(owner)
  activeOwner.current = owner

  const [loadState, setLoadState] = useState<{ owner: typeof owner; status: 'loading' | 'ready' | 'error' }>({ owner, status: 'loading' })
  const loadGeneration = useRef(0)
  const reconcile = useCallback((saved: ApiSettings, sequence: number) => {
    if (activeOwner.current !== owner) return
    const next = { ...saved, general: { ...saved.general } }
    // 旧响应只确认已保存的字段，更新后仍在预览的字段不能被回退。
    for (const key of Object.keys(saved) as (keyof ApiSettings)[]) {
      if (key !== 'general' && (fieldVersions.current.get(key) ?? 0) > sequence) Object.assign(next, { [key]: latestSettings.current[key] })
    }
    for (const key of Object.keys(saved.general) as (keyof ApiSettings['general'])[]) {
      if ((fieldVersions.current.get('general.' + key) ?? 0) > sequence) Object.assign(next.general, { [key]: latestSettings.current.general[key] })
    }
    latestSettings.current = next; setSettings(next); writeLocalSettings(userId, next); setError(undefined)
  }, [owner, userId])

  const track = useCallback(async <T extends ApiSettings | undefined,>(request: Promise<T>): Promise<T> => {
    owner.count += 1; if (activeOwner.current === owner) setSaving(true)
    try { return await request }
    catch (reason) { if (activeOwner.current === owner) setError(reason instanceof Error ? reason.message : '设置保存失败'); throw reason }
    finally { owner.count -= 1; if (activeOwner.current === owner) setSaving(owner.count > 0) }
  }, [owner])

  const flushSettings = useCallback(async (retry = false) => {
    const sequence = changeSequence.current
    const saved = await track(owner.queue.flush(retry))
    if (saved) reconcile(saved, sequence)
  }, [owner, track, reconcile])

  const retrySettingsLoad = useCallback(async () => {
    if (activeOwner.current !== owner) return
    const generation = ++loadGeneration.current
    setLoadState({ owner, status: 'loading' })
    if (!authenticated || !userId) { setLoadState({ owner, status: 'ready' }); return }
    try {
      const result = await apiFetch<{ settings: ApiSettings }>('/api/settings', {}, userId)
      if (activeOwner.current !== owner || generation !== loadGeneration.current) return
      // 加载与重试都不能覆盖当前账号已编辑的字段，包括尚未发送的显示设置。
      reconcile(result.settings, 0)
      setLoadState({ owner, status: 'ready' })
    } catch (reason) {
      if (activeOwner.current === owner && generation === loadGeneration.current) { setError(reason instanceof Error ? reason.message : '设置加载失败'); setLoadState({ owner, status: 'error' }) }
    }
  }, [owner, authenticated, userId, reconcile])

  useEffect(() => {
    owner.queue.resume()
    changeSequence.current += 1
    fieldVersions.current.clear()
    const local = readLocalSettings(userId); latestSettings.current = local; setSettings(local)
    setError(undefined); setSaving(false)
    void retrySettingsLoad()
    return () => { loadGeneration.current++; owner.queue.dispose() }
  }, [owner, userId, retrySettingsLoad])

  useEffect(() => {
    const flush = () => { void flushSettings().catch(() => undefined) }
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', flush)
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flush) }
  }, [flushSettings])

  useEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(settings.theme)
      setResolvedTheme(resolved)
      document.documentElement.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColors[resolved])
    }
    apply()
    if (settings.theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => apply()
    media.addEventListener?.('change', listener)
    return () => media.removeEventListener?.('change', listener)
  }, [settings.theme])

  const value = useMemo<ReaderSettingsContextValue>(() => ({
    settingsLoadStatus: loadState.owner === owner ? loadState.status : 'loading',
    retrySettingsLoad,
    settings,
    resolvedTheme,
    saving,
    canRetrySettings: owner.queue.hasFailed,
    flushSettings,
    ...(error === undefined ? {} : { error }),
    updateSettings: async (patch, options = {}) => {
      if (activeOwner.current !== owner) throw new Error('账号已切换，设置保存已取消')
      setError(undefined)
      const next: ApiSettings = { ...latestSettings.current, ...patch, general: { ...latestSettings.current.general, ...patch.general }, updatedAt: new Date().toISOString() }
      const sequence = ++changeSequence.current
      for (const key of Object.keys(patch)) {
        if (key === 'general') for (const field of Object.keys(patch.general ?? {})) fieldVersions.current.set('general.' + field, sequence)
        else fieldVersions.current.set(key, sequence)
      }
      const optimistic = options.optimistic !== false || session === null || user?.id === undefined
      if (optimistic) { latestSettings.current = next; setSettings(next); writeLocalSettings(user?.id, next) }
      if (session === null || user?.id === undefined) return next
      const displayOnly = Object.keys(patch).every((key) => ['fontSize', 'lineHeight', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft'].includes(key))
      const saved = await track(owner.queue.enqueue(patch, options.debounce === true && options.optimistic !== false && displayOnly))
      reconcile(saved, sequence)
      return saved
    },
  }), [loadState, retrySettingsLoad, error, resolvedTheme, saving, session, settings, user?.id, owner, track, reconcile, flushSettings])
  return <ReaderSettingsContext.Provider value={value}>{children}</ReaderSettingsContext.Provider>
}

export function useReaderSettings(): ReaderSettingsContextValue {
  const value = useContext(ReaderSettingsContext)
  if (value === undefined) throw new Error('useReaderSettings 必须在 ReaderSettingsProvider 内使用')
  return value
}

export function ThemeModeSelect({ className = '' }: { className?: string }) {
  const { settings, updateSettings } = useReaderSettings()
  return <label className={`theme-select ${className}`.trim()}><span className="sr-only">页面模式</span><Select aria-label="页面模式" value={settings.theme} onChange={(event) => void updateSettings({ theme: event.target.value as ApiThemeMode }).catch(() => undefined)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">夜间</option></Select></label>
}

export function ReadingModeSelect({ className = '' }: { className?: string }) {
  const { settings, updateSettings } = useReaderSettings()
  return <label className={`theme-select ${className}`.trim()}><span className="sr-only">阅读模式</span><Select aria-label="阅读模式" value={settings.readingMode} onChange={(event) => void updateSettings({ readingMode: event.target.value as ApiReadingMode }).catch(() => undefined)}><option value="scroll">滚动阅读</option><option value="paged">分页阅读</option></Select></label>
}

function resolveTheme(theme: ApiThemeMode): 'light' | 'dark' { return theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme }
function readLocalSettings(userId: string | undefined): ApiSettings {
  const fallback: ApiSettings = { userId: userId ?? '', ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() }
  try {
    const raw = window.localStorage.getItem(`${storagePrefix}${userId ?? 'anonymous'}`)
    if (raw === null) return fallback
    const value = JSON.parse(raw) as LocalSettingsSnapshot
    const bookshelfSort = value.general?.bookshelfSort === 'lastReadAt' || value.general?.bookshelfSort === 'addedAt' ? value.general.bookshelfSort : fallback.general.bookshelfSort
    return { ...fallback, ...(value.theme === 'system' || value.theme === 'light' || value.theme === 'dark' ? { theme: value.theme } : {}), ...(value.readingMode === 'scroll' || value.readingMode === 'paged' ? { readingMode: value.readingMode } : {}), ...(typeof value.fontSize === 'number' && value.fontSize >= 15 && value.fontSize <= 28 ? { fontSize: value.fontSize } : {}), ...(typeof value.lineHeight === 'number' && value.lineHeight >= 1.4 && value.lineHeight <= 2.6 ? { lineHeight: value.lineHeight } : {}), ...readMargin('marginTop', value.marginTop), ...readMargin('marginRight', value.marginRight), ...readMargin('marginBottom', value.marginBottom), ...readMargin('marginLeft', value.marginLeft), general: { searchConcurrency: searchConcurrencySchema.catch(DEFAULT_SEARCH_CONCURRENCY).parse(value.general?.searchConcurrency), bookshelfSort, bookshelfInitialGroup: typeof value.general?.bookshelfInitialGroup === 'string' ? value.general.bookshelfInitialGroup : 'all' }, pageTapZones: normalizePageTapZones(value.pageTapZones), ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}) }
  } catch { return fallback }
}
function readMargin(key: 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft', value: unknown): Partial<ApiSettings> { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 64 ? { [key]: value } : {} }
function writeLocalSettings(userId: string | undefined, value: ApiSettings): void { try { window.localStorage.setItem(`${storagePrefix}${userId ?? 'anonymous'}`, JSON.stringify({ schemaVersion: 1, ...value })) } catch { /* 私有浏览器模式可能禁用存储 */ } }
