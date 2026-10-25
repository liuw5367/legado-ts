export interface PageMutation { userId: string; path: string; method: string }
const listeners = new Set<(mutation: PageMutation) => void>()
export function subscribePageMutations(listener: (mutation: PageMutation) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function publishPageMutation(mutation: PageMutation) {
  for (const listener of listeners) {
    // 缓存订阅异常不能把已经提交成功的业务操作变成失败。
    try { listener(mutation) } catch { console.error('页面缓存失效通知失败') }
  }
}

/** 列表查询不使数据失效；发现打开书籍可能创建 edition，按成功写入处理。 */
export function mutationDomains(path: string, method: string): string[] {
  if (method === 'GET' || method === 'HEAD') return []
  const parts = path.split('?')[0]!.split('/').filter(Boolean)
  if (parts[1] === 'source-management' && (parts[2] === 'import-preview' || parts.at(-1) === 'undo-preview')) return []
  if (parts[1] === 'source-management' || parts[1] === 'sources') return ['sources', 'discovery', 'home', 'books', 'content']
  if (parts[1] === 'searches' || parts[1] === 'search-history') return ['home', 'candidates']
  if (parts[1] === 'discovery' && parts[2] === 'books') return ['books', 'candidates']
  if (parts[1] === 'book-lists') return parts.at(-1) === 'move-from-bookshelf' ? ['booklists', 'home', 'groups'] : ['booklists']
  if (parts[1] === 'bookshelf-groups') return ['groups', 'home']
  if (parts[1] === 'books' && (parts[3] === 'annotations' || parts[3] === 'bookmarks')) return ['notes']
  if (parts[1] === 'books' && parts[3] === 'bookshelf') return ['home', 'groups', 'books']
  if (parts[1] !== 'books') return []
  if (parts[3] === 'cover') return ['home', 'books', 'booklists', 'booklist-books', `book:${decodeURIComponent(parts[2]!)}`]
  if (parts[3] === 'position') return ['home', 'booklist-books']
  const book = parts[2]
  return ['home', 'candidates', 'booklist-books', ...(book === undefined ? ['books'] : [`book:${decodeURIComponent(book)}`])]
}

/** 页面实例拥有一次读取；取消恢复为 idle，成功或失败都不在激活时自动重试。 */
export class PageResource {
  private identity = ''
  private settled = false
  private generation = 0
  begin(identity: string): { settle: () => void; cancel: () => void } | undefined {
    if (this.identity === identity && this.settled) return undefined
    this.identity = identity; this.settled = false
    const generation = ++this.generation
    return {
      settle: () => { if (generation === this.generation) this.settled = true },
      cancel: () => { if (generation === this.generation && !this.settled) { this.generation++; this.identity = '' } },
    }
  }
}
