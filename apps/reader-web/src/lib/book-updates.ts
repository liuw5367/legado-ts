const memory = new Map<string, boolean>()
const listeners = new Set<() => void>()

function storageKey(userId: string, bookId: string, editionKey: string) {
  return `legado:book-update:v1:${JSON.stringify([userId, bookId, editionKey])}`
}

export function hasBookUpdate(userId: string, bookId: string, editionKey: string): boolean {
  const key = storageKey(userId, bookId, editionKey)
  if (memory.has(key)) return memory.get(key)!
  try {
    const raw = window.localStorage.getItem(key)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return value !== null && typeof value === 'object' && 'version' in value && value.version === 1 && 'updated' in value && value.updated === true
  } catch { return false }
}

export function setBookUpdate(userId: string, bookId: string, editionKey: string, updated: boolean) {
  const key = storageKey(userId, bookId, editionKey)
  if (hasBookUpdate(userId, bookId, editionKey) === updated) return
  memory.set(key, updated)
  try {
    if (updated) window.localStorage.setItem(key, JSON.stringify({ version: 1, updated: true }))
    else window.localStorage.removeItem(key)
  } catch {
    // 存储禁用或配额不足时仍保留当前会话的标记。
  }
  for (const listener of listeners) listener()
}

export function subscribeBookUpdates(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
