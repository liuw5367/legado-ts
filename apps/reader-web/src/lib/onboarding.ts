export const onboardingSteps = [
  {
    title: '从源仓库获取订阅地址',
    description: '打开书源管理，选择“导入”再点“获取书源”。进入源仓库后，找到订阅链接并复制。',
    action: '打开书源管理',
    path: '/sources',
    preview: 'repository',
  },
  {
    title: '确认需要的书源',
    description: '粘贴订阅地址并加载书源。检查可导入列表，保留需要的项目，再确认导入。',
    action: '打开书源管理',
    path: '/sources',
    preview: 'import',
  },
  {
    title: '搜索一本书',
    description: '打开搜索页面，输入书名或作者。搜索结果会按书源显示，你可以比较不同版本。',
    action: '前往搜索',
    path: '/search',
    preview: 'search',
  },
  {
    title: '把书加入书架',
    description: '找到合适的搜索结果，选择“加入书架”。加入后可在首页继续阅读。',
    action: '前往搜索',
    path: '/search',
    preview: 'shelf',
  },
  {
    title: '查看书籍详情',
    description: '打开搜索结果的书籍详情，查看简介、作者和书源信息，再决定是否开始阅读。',
    action: '前往搜索',
    path: '/search',
    preview: 'details',
  },
] as const

const onboardingMemory = new Set<string>()

function onboardingStorageKey(userId: string) {
  return `legado:onboarding:v1:${encodeURIComponent(userId)}`
}

export function hasSeenOnboarding(userId: string): boolean {
  if (onboardingMemory.has(userId)) return true
  try {
    const stored = window.localStorage.getItem(onboardingStorageKey(userId))
    if (stored === null) return false
    const value: unknown = JSON.parse(stored)
    return value !== null && typeof value === 'object' && 'version' in value && value.version === 1 && 'seen' in value && value.seen === true
  } catch {
    return false
  }
}

export function markOnboardingSeen(userId: string) {
  onboardingMemory.add(userId)
  try {
    window.localStorage.setItem(onboardingStorageKey(userId), JSON.stringify({ version: 1, seen: true }))
  } catch {
    // 存储不可用时保留当前会话的记录，避免用户离开后再次自动弹出。
  }
}

export function onboardingReturnTo(value: unknown): string {
  return value === '/account/settings/about' ? value : '/'
}
