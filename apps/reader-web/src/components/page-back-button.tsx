import { type MouseEvent } from 'react'
import { usePageNavigation } from '../lib/use-page-resource.ts'
import { ChevronLeft } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { pageReturnTarget } from '../lib/page-navigation.ts'
import { buttonVariants } from './ui/button.tsx'

export function PageBackButton({ fallback = '/', appearance = 'link', className = 'back-link', label = '返回' }: { fallback?: string; appearance?: 'link' | 'button'; className?: string; label?: string }) {
  const navigation = usePageNavigation()
  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (navigation === null || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault(); navigation.back(target)
  }
  const location = useLocation()
  const target = pageReturnTarget(location.state, location.pathname, fallback)
  if (appearance === 'button') return <Link onClick={back} className={buttonVariants({ variant: 'secondary' })} to={target.to} state={target.state} replace>返回页面</Link>
  return <Link onClick={back} className={className} to={target.to} state={target.state} replace aria-label={label === '返回' ? '返回上一页' : label}><ChevronLeft aria-hidden="true" /><span>{label}</span></Link>
}
