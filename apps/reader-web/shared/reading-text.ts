/** 文本版本标识只用于检测正文变化，不用于安全或授权。 */
export function textFingerprint(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return value.length + ':' + (hash >>> 0).toString(16)
}
