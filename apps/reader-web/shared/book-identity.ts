/** 同书自动归并只使用完整书名和作者，缺失作者不推断为同一本书。 */
export function normalizeIdentity(value: string): string { return value.trim().normalize('NFC') }
export function bookIdentityKey(name: string | undefined, author: string | undefined): string | undefined {
  const title = normalizeIdentity(name ?? '')
  const writer = normalizeIdentity(author ?? '')
  return title.length === 0 || writer.length === 0 || writer === '作者未知' ? undefined : JSON.stringify([title, writer])
}
export function sameBookIdentity(leftName: string, leftAuthor: string | undefined, rightName: string | undefined, rightAuthor: string | undefined): boolean {
  const left = bookIdentityKey(leftName, leftAuthor)
  return left !== undefined && left === bookIdentityKey(rightName, rightAuthor)
}
