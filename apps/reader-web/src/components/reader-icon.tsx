export function ReaderIcon({ name }: { name: 'toc' | 'source' | 'settings' | 'sun' | 'moon' }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'toc' ? <><path d="M8 5h13M8 12h13M8 19h13" /><path d="M3 5h.01M3 12h.01M3 19h.01" /></> : null}
    {name === 'source' ? <><path d="M3 7h17l-4-4M21 17H4l4 4M20 7l-4 4M4 17l4-4" /></> : null}
    {name === 'settings' ? <><path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3z" /><circle cx="12" cy="11" r="3" /></> : null}
    {name === 'sun' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></> : null}
    {name === 'moon' ? <path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z" /> : null}
  </svg>
}
