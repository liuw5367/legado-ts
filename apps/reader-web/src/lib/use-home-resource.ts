import { useRef, useState } from 'react'
import { apiFetch } from './api.ts'
import { usePageLoadEffect, usePageNavigation, usePageVersion } from './use-page-resource.ts'

/** 首页各列表独立结算，切回已加载的 Tab 时复用数据和错误，失效后才重读。 */
export function useHomeResource<T>(path: string, domain: string, enabled = true, cacheKey = '') {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const loaded = useRef('')
  const version = usePageVersion([domain])
  const navigation = usePageNavigation()
  usePageLoadEffect((settle) => {
    if (!enabled) return
    const identity = `${version}:${retry}:${cacheKey}`
    if (loaded.current === identity) { settle(); return }
    const controller = new AbortController()
    setLoading(true); setError('')
    void (async () => {
      try {
        if (domain === 'bookshelf' || domain === 'reading-history') await navigation?.positions.flush()
        if (controller.signal.aborted) return
        const result = await apiFetch<T>(path, { signal: controller.signal })
        if (!controller.signal.aborted) setData(result)
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败')
      } finally {
        if (!controller.signal.aborted) { loaded.current = identity; setLoading(false); settle() }
      }
    })()
    return () => controller.abort()
  }, [enabled, retry, cacheKey], [domain])
  return { data, setData, loading, error, retry: () => setRetry((value) => value + 1) }
}
