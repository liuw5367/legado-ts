export function prepareSourceImportJson(text: string): { jsonText: string; filteredCount: number } {
  if (text.trim().length === 0) throw new Error('JSON 文件内容不能为空')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('文件不是有效的 JSON，请检查文件内容与 UTF-8 编码') }
  let filteredCount = 0
  function keep(item: unknown): boolean {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return true
    const type = (item as Record<string, unknown>).bookSourceType
    // 未填写类型的旧书源默认为文本；类型 3 是文本文件，仍属于书籍。
    if (typeof type !== 'number' || !Number.isInteger(type) || type === 0 || type === 3) return true
    filteredCount++
    return false
  }
  const filtered = Array.isArray(value) ? value.filter(keep) : keep(value) ? value : []
  if (filteredCount > 0 && Array.isArray(filtered) && filtered.length === 0) throw new Error('文件中的书源均为非书籍类型，过滤后没有可导入的书源')
  return { jsonText: JSON.stringify(filtered), filteredCount }
}
