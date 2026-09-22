export type ReaderAction = 'read' | 'detail' | 'toc' | 'sources'

export interface ActionMenuContext {
  hasBook: boolean
  hasSources: boolean
  hasToc: boolean
  /** 允许打开操作菜单的页面；目录、正文和书源页不再直接显示操作入口。 */
  page: 'home' | 'results' | 'detail'
  busy: boolean
}

export interface ActionMenuItem {
  action: ReaderAction
  label: string
  enabled: boolean
  reason?: string
}

/** 所有书籍上下文页面共用的动作顺序和禁用原因。 */
export function actionMenuItems(context: ActionMenuContext): ActionMenuItem[] {
  const readLabel = context.hasBook ? '继续阅读' : '开始阅读'
  return [
    { action: 'read', label: readLabel, enabled: context.hasBook && !context.busy, ...(context.hasBook ? {} : { reason: '当前项没有书籍上下文' }) },
    { action: 'detail', label: '书籍信息', enabled: context.hasBook && context.page !== 'detail' && !context.busy, ...(context.page === 'detail' ? { reason: '当前已经是书籍详情页' } : context.hasBook ? {} : { reason: '当前项没有书籍上下文' }) },
    { action: 'toc', label: '章节列表', enabled: context.hasBook && context.hasToc && !context.busy, ...(context.hasToc ? {} : { reason: '当前书源尚未加载目录' }) },
    { action: 'sources', label: '书源切换', enabled: context.hasBook && context.hasSources && !context.busy, ...(context.hasSources ? {} : { reason: '尚未搜索到可切换书源' }) },
  ]
}

export function actionMenuLabel(item: ActionMenuItem): string {
  return item.enabled ? item.label : `${item.label}（${item.reason ?? '暂不可用'}）`
}
