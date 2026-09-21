type EncodedValue = null | string | boolean | number | {
  t: 'undefined' | 'bigint' | 'date' | 'bytes' | 'number' | 'array' | 'object' | 'ref'
  v?: string | number[] | Record<string, EncodedValue> | EncodedValue[]
  id?: string
}

export class JavaScriptSerializationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'JavaScriptSerializationError'
  }
}

export function encodeJavaScriptValue(value: unknown): string {
  const seen = new Map<object, string>()
  let nextId = 0

  const encode = (current: unknown): EncodedValue => {
    if (current === undefined) return { t: 'undefined' }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return { t: 'number', v: 'NaN' }
      if (current === Infinity) return { t: 'number', v: 'Infinity' }
      if (current === -Infinity) return { t: 'number', v: '-Infinity' }
      if (Object.is(current, -0)) return { t: 'number', v: '-0' }
      return current
    }
    if (typeof current === 'bigint') return { t: 'bigint', v: current.toString() }
    if (typeof current === 'function' || typeof current === 'symbol') throw new JavaScriptSerializationError(`unsupported value type: ${typeof current}`)
    if (current instanceof Date) return { t: 'date', v: current.toISOString() }
    if (current instanceof Uint8Array) return { t: 'bytes', v: Array.from(current) }
    if (current instanceof ArrayBuffer) return { t: 'bytes', v: Array.from(new Uint8Array(current)) }
    if (current instanceof Map || current instanceof Set) throw new JavaScriptSerializationError('Map and Set values are not supported')
    const object = current as object
    const existingId = seen.get(object)
    if (existingId !== undefined) return { t: 'ref', v: existingId }
    const id = String(nextId++)
    seen.set(object, id)
    if (Array.isArray(current)) return { t: 'array', id, v: current.map((item) => encode(item)) }
    const properties: Record<string, EncodedValue> = {}
    for (const key of Object.keys(current)) Object.defineProperty(properties, key, { value: encode((current as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true })
    return { t: 'object', id, v: properties }
  }

  return JSON.stringify(encode(value))
}

export function decodeJavaScriptValue(serialized: string): unknown {
  const root = JSON.parse(serialized) as EncodedValue
  const references = new Map<string, object>()

  const decode = (current: EncodedValue): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number') return current
    if (current.t === 'undefined') return undefined
    if (current.t === 'bigint') return BigInt(current.v as string)
    if (current.t === 'date') return new Date(current.v as string)
    if (current.t === 'bytes') return Uint8Array.from(current.v as number[])
    if (current.t === 'number') {
      if (current.v === 'NaN') return NaN
      if (current.v === 'Infinity') return Infinity
      if (current.v === '-Infinity') return -Infinity
      return -0
    }
    if (current.t === 'ref') {
      const reference = references.get(current.v as string)
      if (reference === undefined) throw new JavaScriptSerializationError('dangling object reference')
      return reference
    }
    if (current.t === 'array') {
      const result: unknown[] = []
      references.set(current.id as string, result)
      for (const item of current.v as EncodedValue[]) result.push(decode(item))
      return result
    }
    const result: Record<string, unknown> = {}
    references.set(current.id as string, result)
    for (const [key, item] of Object.entries(current.v as Record<string, EncodedValue>)) Object.defineProperty(result, key, { value: decode(item), enumerable: true, writable: true, configurable: true })
    return result
  }

  return decode(root)
}

/**
 * The guest-side half of the tagged codec. It intentionally has no access to
 * host globals; bridge functions are installed separately by the executor.
 */
export const guestCodecSource = String.raw`(() => {
  const decode = (root) => {
    const references = new Map()
    const visit = (value) => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
      if (value.t === 'undefined') return undefined
      if (value.t === 'bigint') return BigInt(value.v)
      if (value.t === 'date') return new Date(value.v)
      if (value.t === 'bytes') return Uint8Array.from(value.v)
      if (value.t === 'number') return value.v === 'NaN' ? NaN : value.v === 'Infinity' ? Infinity : value.v === '-Infinity' ? -Infinity : -0
      if (value.t === 'ref') {
        if (!references.has(value.v)) throw new Error('__LEGADO_SERIALIZATION__ dangling object reference')
        return references.get(value.v)
      }
      if (value.t === 'array') {
        const result = []
        references.set(value.id, result)
        for (const item of value.v) result.push(visit(item))
        return result
      }
      if (value.t === 'object') {
        const result = {}
        references.set(value.id, result)
        for (const key of Object.keys(value.v)) Object.defineProperty(result, key, { value: visit(value.v[key]), enumerable: true, writable: true, configurable: true })
        return result
      }
      throw new Error('__LEGADO_SERIALIZATION__ unknown tagged value')
    }
    return visit(root)
  }
  const freeze = (value, seen = new Set()) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return value
    seen.add(value)
    for (const key of Object.keys(value)) freeze(value[key], seen)
    return Object.freeze(value)
  }
  const encode = (root) => {
    const references = new Map()
    let nextId = 0
    const visit = (value) => {
      if (value === undefined) return { t: 'undefined' }
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return { t: 'number', v: 'NaN' }
        if (value === Infinity) return { t: 'number', v: 'Infinity' }
        if (value === -Infinity) return { t: 'number', v: '-Infinity' }
        if (Object.is(value, -0)) return { t: 'number', v: '-0' }
        return value
      }
      if (typeof value === 'bigint') return { t: 'bigint', v: value.toString() }
      if (typeof value === 'function' || typeof value === 'symbol') throw new Error('__LEGADO_SERIALIZATION__ unsupported value type')
      if (value instanceof Date) return { t: 'date', v: value.toISOString() }
      if (value instanceof Uint8Array) return { t: 'bytes', v: Array.from(value) }
      if (value instanceof Map || value instanceof Set) throw new Error('__LEGADO_SERIALIZATION__ Map and Set values are not supported')
      if (references.has(value)) return { t: 'ref', v: references.get(value) }
      const id = String(nextId++)
      references.set(value, id)
      if (Array.isArray(value)) return { t: 'array', id, v: value.map(visit) }
      const result = {}
      for (const key of Object.keys(value)) Object.defineProperty(result, key, { value: visit(value[key]), enumerable: true, writable: true, configurable: true })
      return { t: 'object', id, v: result }
    }
    return JSON.stringify(visit(root))
  }
  globalThis.__legadoDecode = decode
  globalThis.__legadoEncode = encode
  globalThis.__legadoFreeze = freeze
})()`
