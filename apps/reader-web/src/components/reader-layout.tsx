import { Outlet } from 'react-router-dom'

export function ReaderLayout() {
  return <div className="reader-shell"><main className="reader-main"><Outlet /></main></div>
}
