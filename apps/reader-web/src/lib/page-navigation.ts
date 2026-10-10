interface ReturnState { backTo?: unknown; backState?: unknown }
/** 仅接受站内路径，防止深链返回到外站或自身页面。 */
export function pageReturnTarget(state: unknown, currentPath: string, fallback: string): { to: string; state: unknown } {
  const value = state !== null && typeof state === 'object' ? state as ReturnState : {}
  const target = value.backTo
  // 控制字符和反斜线会改变URL解析结果；拒绝协议相对URL。
  const safe = typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !/[\\\u0000-\u001f]/u.test(target) && target.split('?')[0] !== currentPath
  return { to: safe ? target : fallback, state: safe ? value.backState : undefined }
}
export function pageReturnState(location: { pathname: string; search: string; state: unknown }): { backTo: string; backState: unknown } {
  return { backTo: location.pathname + location.search, backState: location.state }
}
