import { normalizeIdentity } from './book-identity.ts'

/** 同一关键词按请求创建时间保留最新一条，完成时间不能改变优先级。 */
export function latestSearchHistory<T extends { id: string; keyword: string; createdAt: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).filter((item) => {
    const key = normalizeIdentity(item.keyword)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
