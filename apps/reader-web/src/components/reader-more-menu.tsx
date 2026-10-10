import { Ellipsis, ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { browserUrl } from '../lib/reader-interactions.ts'

export function ReaderMoreMenu({ url, refreshing, onRefresh }: { url: string; refreshing: boolean; onRefresh: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const address = browserUrl(url)
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open') }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  function closeMenu() { ref.current?.removeAttribute('open'); ref.current?.querySelector('summary')?.focus() }
  return <details ref={ref} className="reader-more" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeMenu() } }}>
    <summary aria-label="更多阅读操作"><Ellipsis aria-hidden="true" /></summary>
    <div className="reader-more-actions">
      {address === undefined ? <span className="muted small">没有可用的原地址</span> : <a href={address} target="_blank" rel="noopener noreferrer" onClick={closeMenu}><ExternalLink aria-hidden="true" />原地址</a>}
      <button type="button" disabled={refreshing} onClick={() => { closeMenu(); onRefresh() }}><RefreshCw aria-hidden="true" />{refreshing ? '刷新中…' : '刷新'}</button>
    </div>
  </details>
}
