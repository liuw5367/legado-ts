import { ArrowLeftRight, List, Settings, Sun, Moon } from 'lucide-react'

/** 保留原调用契约，图形统一使用项目选定的Lucide。 */
export function ReaderIcon({ name }: { name: 'toc' | 'source' | 'settings' | 'sun' | 'moon' }) {
  const Icon = { toc: List, source: ArrowLeftRight, settings: Settings, sun: Sun, moon: Moon }[name]
  return <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
}
