import { useEffect, useState } from 'react'

export function BookCover({ name, coverUrl, size = 'small' }: { name: string; coverUrl: string | undefined; size?: 'small' | 'result' }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [coverUrl])
  const initial = name.trim().slice(0, 1) || '书'
  const className = `book-cover book-cover-${size}`
  if (coverUrl !== undefined && coverUrl.length > 0 && !failed) return <img className={className} src={coverUrl} alt="" width="48" height="64" loading="lazy" onError={() => setFailed(true)} />
  return <span className={className} aria-hidden="true">{initial}</span>
}
