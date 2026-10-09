import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { RuntimeStateSnapshot } from '../domain/types.ts'

const FORMAT_VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
export const MAX_RUNTIME_STATE_BYTES = 512 * 1024

/**
 * Encrypt source cookies and source variables before they leave the process.
 * The database is intentionally unable to read this payload without the
 * deployment secret.
 */
export function encryptRuntimeState(snapshot: RuntimeStateSnapshot, secret: string = configuredSecret()): string {
  const key = deriveKey(secret)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(normalizeSnapshot(snapshot)), 'utf8')
  if (plaintext.byteLength > MAX_RUNTIME_STATE_BYTES) throw new Error('书源运行状态超过大小限制')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return [FORMAT_VERSION, encode(iv), encode(tag), encode(ciphertext)].join('.')
}

export function decryptRuntimeState(value: string, secret: string = configuredSecret()): RuntimeStateSnapshot {
  try {
    const [version, encodedIv, encodedTag, encodedCiphertext] = value.split('.')
    if (version !== FORMAT_VERSION || encodedIv === undefined || encodedTag === undefined || encodedCiphertext === undefined) throw new Error('invalid format')
    const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), decode(encodedIv))
    decipher.setAuthTag(decode(encodedTag))
    const plaintext = Buffer.concat([decipher.update(decode(encodedCiphertext)), decipher.final()]).toString('utf8')
    return normalizeSnapshot(JSON.parse(plaintext) as unknown)
  } catch {
    throw new Error('书源运行状态解密失败')
  }
}

export function configuredSecret(): string {
  const secret = process.env.SOURCE_RUNTIME_STATE_KEY?.trim() ?? ''
  if (secret.length < 32) throw new Error('SOURCE_RUNTIME_STATE_KEY 未配置或长度不足 32 个字符')
  return secret
}

export function normalizeSnapshot(value: unknown): RuntimeStateSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid snapshot')
  const input = value as Record<string, unknown>
  const output: RuntimeStateSnapshot = {}
  if (input.cookies !== undefined) {
    if (typeof input.cookies !== 'string') throw new Error('invalid cookies')
    output.cookies = input.cookies
  }
  if (input.variables !== undefined) {
    if (typeof input.variables !== 'object' || input.variables === null || Array.isArray(input.variables)) throw new Error('invalid variables')
    const variables: Record<string, string> = {}
    for (const [name, variable] of Object.entries(input.variables as Record<string, unknown>)) {
      if (typeof variable !== 'string') throw new Error('invalid variable')
      variables[name] = variable
    }
    output.variables = variables
  }
  if (input.cache !== undefined) {
    if (typeof input.cache !== 'object' || input.cache === null || Array.isArray(input.cache)) throw new Error('invalid cache')
    const cache: NonNullable<RuntimeStateSnapshot['cache']> = {}
    for (const [name, entry] of Object.entries(input.cache as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('invalid cache entry')
      const candidate = entry as Record<string, unknown>
      if (typeof candidate.value !== 'string' || (candidate.expiresAt !== undefined && typeof candidate.expiresAt !== 'number')) throw new Error('invalid cache value')
      cache[name] = { value: candidate.value, ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }) }
    }
    output.cache = cache
  }
  return output
}

function deriveKey(secret: string): Buffer {
  if (secret.length === 0) throw new Error('empty runtime state secret')
  return createHash('sha256').update(secret, 'utf8').digest()
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}
