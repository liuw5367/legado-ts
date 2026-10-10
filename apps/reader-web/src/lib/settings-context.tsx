import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from './auth-context.tsx'
import { apiFetch, type ApiSettings, type ApiThemeMode } from './api.ts'
import { Select } from '../components/ui/select.tsx'

export const DEFAULT_SETTINGS: Omit<ApiSettings, 'userId' | 'updatedAt'> = { theme: 'system', fontSize: 18, lineHeight: 1.9 }
type SettingsPatch = Partial<Pick<ApiSettings, 'theme' | 'fontSize' | 'lineHeight'>>
interface ReaderSettingsContextValue { settings: ApiSettings; resolvedTheme: 'light' | 'dark'; saving: boolean; error?: string; updateSettings: (patch: SettingsPatch) => Promise<ApiSettings> }
const ReaderSettingsContext = createContext<ReaderSettingsContextValue | undefined>(undefined)
const storagePrefix = 'legado-reader-settings:'
const themeColors: Record<'light' | 'dark', string> = { light: '#f6f3ed', dark: '#171513' }

export function ReaderSettingsProvider({ children }: { children: ReactNode }) {
  const { session, user } = useAuth()
  const [settings, setSettings] = useState<ApiSettings>(() => readLocalSettings(undefined))
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme('system'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const saveQueue = useRef(Promise.resolve())
  const activeUserId = useRef<string | undefined>(undefined)

  useEffect(() => {
    const userId = user?.id
    activeUserId.current = userId
    setSettings(readLocalSettings(userId))
    setError(undefined)
    if (session === null || userId === undefined) return
    let active = true
    void apiFetch<{ settings: ApiSettings }>('/api/settings').then((result) => {
      if (!active) return
      setSettings(result.settings)
      writeLocalSettings(userId, result.settings)
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '阅读设置加载失败')
    })
    return () => { active = false }
  }, [session, user?.id])

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
    settings,
    resolvedTheme,
    saving,
    ...(error === undefined ? {} : { error }),
    updateSettings: async (patch) => {
      const next: ApiSettings = { ...settings, ...patch, updatedAt: new Date().toISOString() }
      setSettings(next)
      writeLocalSettings(user?.id, next)
      if (session === null || user?.id === undefined) return next
      setSaving(true)
      const request = saveQueue.current.then(async () => {
        const result = await apiFetch<{ settings: ApiSettings }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) })
        if (activeUserId.current === user.id) {
          setSettings(result.settings)
          writeLocalSettings(user.id, result.settings)
          setError(undefined)
        }
        return result.settings
      })
      saveQueue.current = request.then(() => undefined, () => undefined)
      try { return await request } catch (reason) { setError(reason instanceof Error ? reason.message : '阅读设置保存失败'); throw reason } finally { setSaving(false) }
    },
  }), [error, resolvedTheme, saving, session, settings, user?.id])
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

function resolveTheme(theme: ApiThemeMode): 'light' | 'dark' { return theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme }
function readLocalSettings(userId: string | undefined): ApiSettings { const fallback: ApiSettings = { userId: userId ?? '', ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() }; try { const raw = window.localStorage.getItem(`${storagePrefix}${userId ?? 'anonymous'}`); if (raw === null) return fallback; const value = JSON.parse(raw) as Partial<ApiSettings>; return { ...fallback, ...(value.theme === 'system' || value.theme === 'light' || value.theme === 'dark' ? { theme: value.theme } : {}), ...(typeof value.fontSize === 'number' && value.fontSize >= 15 && value.fontSize <= 28 ? { fontSize: value.fontSize } : {}), ...(typeof value.lineHeight === 'number' && value.lineHeight >= 1.4 && value.lineHeight <= 2.6 ? { lineHeight: value.lineHeight } : {}), ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}) } } catch { return fallback } }
function writeLocalSettings(userId: string | undefined, value: ApiSettings): void { try { window.localStorage.setItem(`${storagePrefix}${userId ?? 'anonymous'}`, JSON.stringify(value)) } catch { /* 私有浏览器模式可能禁用存储 */ } }
