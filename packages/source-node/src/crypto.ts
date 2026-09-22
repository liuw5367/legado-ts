import { createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto'
import type { CryptoHost, DigestAlgorithm, SymmetricCrypto } from '@legado/source-core'
import { NodeEncodingHost } from './encoding.ts'

function bufferOf(input: string | Uint8Array): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
}

function nodeAlgorithm(algorithm: DigestAlgorithm): string {
  return algorithm === 'sha1' ? 'sha1' : algorithm
}

function cipherAlgorithm(transformation: string, key: Uint8Array): { algorithm: string; ivRequired: boolean } {
  const parts = transformation.split('/')
  if (parts.length !== 3 || parts[2] !== 'PKCS5Padding' && parts[2] !== 'PKCS7Padding') throw new Error(`unsupported transformation: ${transformation}`)
  const mode = parts[1]!.toLowerCase()
  if (parts[0] === 'AES' && (mode === 'cbc' || mode === 'ecb') && [16, 24, 32].includes(key.byteLength)) return { algorithm: `aes-${key.byteLength * 8}-${mode}`, ivRequired: mode === 'cbc' }
  if ((parts[0] === 'DES' || parts[0] === 'DESede' || parts[0] === '3DES') && (mode === 'cbc' || mode === 'ecb')) {
    if (parts[0] === 'DES' && key.byteLength === 8) return { algorithm: `des-${mode}`, ivRequired: mode === 'cbc' }
    if ((parts[0] === 'DESede' || parts[0] === '3DES') && key.byteLength === 24) return { algorithm: `des-ede3-${mode}`, ivRequired: mode === 'cbc' }
  }
  throw new Error(`unsupported transformation: ${transformation}`)
}

class NodeSymmetricCrypto implements SymmetricCrypto {
  private readonly descriptor: { algorithm: string; ivRequired: boolean }
  private readonly key: Buffer
  private readonly iv: Buffer | null
  private readonly encoding: NodeEncodingHost

  public constructor(transformation: string, key: Uint8Array, iv: Uint8Array | undefined, encoding: NodeEncodingHost) {
    this.descriptor = cipherAlgorithm(transformation, key)
    this.key = Buffer.from(key)
    const parsedIv = this.descriptor.ivRequired ? Buffer.from(iv ?? (() => { throw new Error('CBC transformation requires iv') })()) : null
    if (this.descriptor.ivRequired && parsedIv !== null && parsedIv.length !== 16 && this.descriptor.algorithm.startsWith('aes-')) throw new Error('AES CBC iv must be 16 bytes')
    if (this.descriptor.ivRequired && parsedIv !== null && parsedIv.length !== 8 && this.descriptor.algorithm.startsWith('des')) throw new Error('DES CBC iv must be 8 bytes')
    this.iv = parsedIv
    this.encoding = encoding
  }

  public decrypt(input: Uint8Array): Uint8Array {
    const decipher = createDecipheriv(this.descriptor.algorithm, this.key, this.iv)
    return Uint8Array.from(Buffer.concat([decipher.update(Buffer.from(input)), decipher.final()]))
  }

  public encrypt(input: Uint8Array): Uint8Array {
    const cipher = createCipheriv(this.descriptor.algorithm, this.key, this.iv)
    return Uint8Array.from(Buffer.concat([cipher.update(Buffer.from(input)), cipher.final()]))
  }

  public decryptText(input: Uint8Array, charset = 'utf-8'): string {
    return this.encoding.decode(this.decrypt(input), charset)
  }

  public encryptText(input: string, charset = 'utf-8'): Uint8Array {
    return this.encrypt(this.encoding.encode(input, charset))
  }
}

export class NodeCryptoHost implements CryptoHost {
  private readonly encoding: NodeEncodingHost

  public constructor(encoding = new NodeEncodingHost()) {
    this.encoding = encoding
  }

  public digestHex(input: string | Uint8Array, algorithm: DigestAlgorithm = 'sha256'): string {
    return createHash(nodeAlgorithm(algorithm)).update(bufferOf(input)).digest('hex')
  }

  public digestBase64(input: string | Uint8Array, algorithm: DigestAlgorithm = 'sha256'): string {
    return createHash(nodeAlgorithm(algorithm)).update(bufferOf(input)).digest('base64')
  }

  public hmacHex(input: string | Uint8Array, key: string | Uint8Array, algorithm: DigestAlgorithm = 'sha256'): string {
    return createHmac(nodeAlgorithm(algorithm), bufferOf(key)).update(bufferOf(input)).digest('hex')
  }

  public createSymmetricCrypto(transformation: string, key: Uint8Array, iv?: Uint8Array): SymmetricCrypto {
    return new NodeSymmetricCrypto(transformation, key, iv, this.encoding)
  }
}
