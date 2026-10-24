import { BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'

export function BookCover({ name, coverUrl, size = 'small', iconFallback = false }: { name: string; coverUrl: string | undefined; size?: 'small' | 'result' | 'detail'; iconFallback?: boolean }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [coverUrl])
  const initial = name.trim().slice(0, 1) || '书'
  const className = `book-cover book-cover-${size}`
  if (coverUrl !== undefined && coverUrl.length > 0 && !failed) return <img className={className} src={coverUrl} alt="" width={size === 'detail' ? 84 : 48} height={size === 'detail' ? 112 : 64} loading="lazy" onError={() => setFailed(true)} />
  return <span className={className} aria-hidden="true">{iconFallback ? <BookOpen aria-hidden="true" /> : initial}</span>
}
