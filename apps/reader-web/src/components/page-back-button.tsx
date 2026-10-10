import { ChevronLeft } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { pageReturnTarget } from '../lib/page-navigation.ts'

export function PageBackButton({ fallback = '/' }: { fallback?: string }) {
  const location = useLocation()
  const target = pageReturnTarget(location.state, location.pathname, fallback)
  return <Link className="back-link" to={target.to} state={target.state} replace aria-label="返回上一页"><ChevronLeft aria-hidden="true" /><span>返回</span></Link>
}
