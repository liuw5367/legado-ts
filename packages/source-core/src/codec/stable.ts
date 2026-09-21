import type { JsonValue } from '../model/types.ts'

export function stableJson(value: JsonValue | undefined): string {
  if (value === undefined) return '__undefined__'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function topLevelDiff(left: JsonValue, right: JsonValue): string[] {
  if (left === right) return []
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return ['$']
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].filter((key) => stableJson(left[key] as JsonValue | undefined) !== stableJson(right[key] as JsonValue | undefined)).sort()
}
