interface ReturnState { backTo?: unknown; backState?: unknown; readingOriginKey?: unknown; readingBackTo?: unknown; resumeReadingKey?: unknown }
/** 仅接受站内路径，防止深链返回到外站或自身页面。 */
export function pageReturnTarget(state: unknown, currentPath: string, fallback: string): { to: string; state: unknown } {
  const value = state !== null && typeof state === 'object' ? state as ReturnState : {}
  const target = value.backTo
  // 控制字符和反斜线会改变URL解析结果；拒绝协议相对URL。
  const safe = typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !/[\\\u0000-\u001f]/u.test(target) && target.split('?')[0] !== currentPath
  return { to: safe ? target : fallback, state: safe ? value.backState : undefined }
}
export function pageReturnState(location: { key?: string; pathname: string; search: string; state: unknown }): { backTo: string; backState?: unknown; readingOriginKey?: string; readingBackTo?: string } {
  const previous = location.state as ReturnState | null
  // 老调用者未提供 key 时保留旧契约；新页面状态只保存扁平来源引用。
  if (location.key === undefined) return { backTo: location.pathname + location.search, backState: location.state }
  const reading = /^\/books\/[^/]+\/read(?:\/|$)/u.test(location.pathname)
  return {
    backTo: location.pathname + location.search,
    ...(reading ? { readingOriginKey: location.key, readingBackTo: typeof previous?.backTo === 'string' ? previous.backTo : '/' }
      : typeof previous?.readingOriginKey === 'string' ? { readingOriginKey: previous.readingOriginKey, readingBackTo: typeof previous.readingBackTo === 'string' ? previous.readingBackTo : '/' } : {}),
  }
}

/** 在阅读中打开目录/换源/详情后再读章节，继承原阅读入口，避免插入中途查看页。 */
export function readingEntryState(location: { key?: string; pathname: string; search: string; state: unknown }): unknown {
  const origin = location.state as ReturnState | null
  if (typeof origin?.readingOriginKey === 'string') return { backTo: typeof origin.readingBackTo === 'string' ? origin.readingBackTo : '/', resumeReadingKey: origin.readingOriginKey }
  let state: unknown = location.state
  const seen = new Set<unknown>()
  while (seen.size < 32 && state !== null && typeof state === 'object' && !seen.has(state)) {
    seen.add(state)
    const value = state as ReturnState
    // 允许目录、详情、换源多层往返；最终目标仍交由pageReturnTarget校验。
    if (typeof value.backTo === 'string' && /^\/books\/[^/]+\/read(?:\/|\?|$)/u.test(value.backTo)) return value.backState ?? { backTo: '/' }
    state = value.backState
  }
  return pageReturnState(location)
}
