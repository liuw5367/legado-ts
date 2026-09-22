import type { JsonObject, JsonValue, NormalizedSource } from '../model/types.ts'

/**
 * These fields affect presentation, ordering, enablement or telemetry, not
 * the source's rule/request definition.  A renamed or re-ordered source must
 * therefore keep the same definition fingerprint.
 */
const nonDefinitionFields = new Set([
  'bookSourceName',
  'bookSourceGroup',
  'bookSourceComment',
  'customOrder',
  'enabled',
  'enabledExplore',
  'lastUpdateTime',
  'respondTime',
  'weight',
  'customButton',
])

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const object: JsonObject = {}
  for (const key of Object.keys(value).sort()) object[key] = canonical(value[key]!)
  return object
}

function definition(source: NormalizedSource): JsonObject {
  const value: JsonObject = {}
  for (const [key, item] of Object.entries(source)) if (!nonDefinitionFields.has(key)) value[key] = canonical(item)
  return value
}

function hash(text: string): string {
  // FNV-1a keeps this utility runtime-neutral; the fingerprint is a grouping
  // key, not a security or authorization token.
  let value = 0xcbf29ce484222325n
  const mask = 0xffffffffffffffffn
  for (const character of text) {
    value ^= BigInt(character.codePointAt(0) ?? 0)
    value = (value * 0x100000001b3n) & mask
  }
  return value.toString(16).padStart(16, '0')
}

export function sourceDefinitionFingerprint(source: NormalizedSource): string {
  return hash(JSON.stringify(canonical(definition(source))))
}

export function sameSourceDefinition(left: NormalizedSource, right: NormalizedSource): boolean {
  return sourceDefinitionFingerprint(left) === sourceDefinitionFingerprint(right)
}

interface RuntimeCrypto {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

function randomUuid(): string {
  const runtimeCrypto = (globalThis as unknown as { crypto?: RuntimeCrypto }).crypto
  if (runtimeCrypto?.randomUUID !== undefined) return runtimeCrypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (runtimeCrypto?.getRandomValues !== undefined) runtimeCrypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createSourceUuid(factory?: () => string): string {
  const supplied = factory?.()
  return supplied !== undefined && supplied.trim().length > 0 ? supplied : randomUuid()
}
