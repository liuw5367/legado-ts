import { ChevronLeft } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { pageReturnTarget } from '../lib/page-navigation.ts'
import { buttonVariants } from './ui/button.tsx'

export function PageBackButton({ fallback = '/', appearance = 'link' }: { fallback?: string; appearance?: 'link' | 'button' }) {
  const location = useLocation()
  const target = pageReturnTarget(location.state, location.pathname, fallback)
  if (appearance === 'button') return <Link className={buttonVariants({ variant: 'secondary' })} to={target.to} state={target.state} replace>返回页面</Link>
  return <Link className="back-link" to={target.to} state={target.state} replace aria-label="返回上一页"><ChevronLeft aria-hidden="true" /><span>返回</span></Link>
}
