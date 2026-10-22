import { constants, createHash, createHmac, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync, getCiphers, privateDecrypt, privateEncrypt, publicDecrypt, publicEncrypt, randomBytes } from 'node:crypto'
import type { CipherCCM, CipherCCMTypes, CipherGCM, CipherGCMTypes, DecipherCCM, DecipherGCM } from 'node:crypto'
import type { TransformOptions } from 'node:stream'
import type { AsymmetricCrypto, CryptoHost, CryptoKeyInput, DigestAlgorithm, SignCrypto, SymmetricCrypto } from '@legado/source-core'
import { NodeEncodingHost } from './encoding.ts'

function bufferOf(input: string | Uint8Array): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
}

function nodeAlgorithm(algorithm: DigestAlgorithm): string {
  return algorithm === 'sha1' ? 'sha1' : algorithm
}

interface CipherDescriptor {
  algorithm: string
  keyBytes?: Uint8Array
  ivRequired: boolean
  autoPadding: boolean
  ivLength: number
  authenticated: boolean
  authMode?: 'ccm' | 'gcm'
  authTagLength: number
}

function unsupportedTransformation(transformation: string, detail = 'unsupported'): Error {
  return new Error(`__LEGADO_CAPABILITY__runtime crypto.${detail}: ${transformation}`)
}

function cipherAlgorithm(transformation: string, key: Uint8Array): CipherDescriptor {
  const shorthand = /^(?:AES|DES|DESede|3DES|SM4)$/iu.test(transformation) ? `${transformation}/ECB/PKCS5Padding` : transformation
  const parts = shorthand.split('/')
  if (parts.length !== 3) throw unsupportedTransformation(transformation)
  const family = parts[0]!.toLowerCase()
  const mode = parts[1]!.toLowerCase()
  const padding = parts[2]!.toLowerCase()
  const autoPadding = padding === 'pkcs5padding' || padding === 'pkcs7padding'
  if (!autoPadding && padding !== 'nopadding') throw unsupportedTransformation(transformation)
  if (family === 'sm2' || family === 'sm3') throw unsupportedTransformation(transformation, 'provider')
  const supportedModes = new Set(['cbc', 'ecb', 'ctr', 'cfb', 'cfb8', 'ofb', 'gcm', 'ccm'])
  if (!supportedModes.has(mode)) throw unsupportedTransformation(transformation)
  if ((mode === 'gcm' || mode === 'ccm') && (family !== 'aes' || autoPadding)) throw unsupportedTransformation(transformation, 'provider')
  if (family === 'aes' && [16, 24, 32].includes(key.byteLength)) {
    const algorithm = `aes-${key.byteLength * 8}-${mode}`
    if (!getCiphers().includes(algorithm)) throw unsupportedTransformation(transformation, 'provider')
    return { algorithm, ivRequired: mode !== 'ecb', autoPadding, ivLength: mode === 'gcm' || mode === 'ccm' ? 0 : 16, authenticated: mode === 'gcm' || mode === 'ccm', ...(mode === 'gcm' || mode === 'ccm' ? { authMode: mode } : {}), authTagLength: mode === 'gcm' || mode === 'ccm' ? 16 : 0 }
  }
  if (family === 'sm4' && key.byteLength === 16 && mode !== 'gcm' && mode !== 'ccm') {
    const algorithm = `sm4-${mode}`
    if (!getCiphers().includes(algorithm)) throw unsupportedTransformation(transformation, 'provider')
    return { algorithm, ivRequired: mode !== 'ecb', autoPadding, ivLength: mode === 'ecb' ? 0 : 16, authenticated: false, authTagLength: 0 }
  }
  if (family === 'des' || family === 'desede' || family === '3des') {
    let algorithm: string | undefined
    if (family === 'des' && key.byteLength === 8) algorithm = `des-${mode}`
    if ((family === 'desede' || family === '3des') && key.byteLength === 16) algorithm = `des-ede-${mode}`
    if ((family === 'desede' || family === '3des') && key.byteLength === 24) algorithm = `des-ede3-${mode}`
    if (algorithm !== undefined && !getCiphers().includes(algorithm) && family === 'des' && key.byteLength === 8) {
      const edeAlgorithm = `des-ede-${mode}`
      if (getCiphers().includes(edeAlgorithm)) return { algorithm: edeAlgorithm, keyBytes: Uint8Array.from([...key, ...key]), ivRequired: mode !== 'ecb', autoPadding, ivLength: 8, authenticated: false, authTagLength: 0 }
    }
    if (algorithm !== undefined) {
      if (!getCiphers().includes(algorithm)) throw unsupportedTransformation(transformation, 'provider')
      return { algorithm, ivRequired: mode !== 'ecb', autoPadding, ivLength: 8, authenticated: false, authTagLength: 0 }
    }
  }
  throw unsupportedTransformation(transformation)
}

function generatedKeyLength(transformation: string): number {
  const family = transformation.split('/')[0]?.toLowerCase()
  if (family === 'des') return 8
  if (family === 'desede' || family === '3des') return 24
  return 16
}

class NodeSymmetricCrypto implements SymmetricCrypto {
  private readonly descriptor: CipherDescriptor
  private readonly key: Buffer
  private readonly secretKey: Buffer
  private iv: Buffer | null
  private readonly encoding: NodeEncodingHost

  public constructor(transformation: string, key: Uint8Array | undefined, iv: Uint8Array | undefined, encoding: NodeEncodingHost) {
    const effectiveKey = key === undefined ? Uint8Array.from(randomBytes(generatedKeyLength(transformation))) : key
    this.descriptor = cipherAlgorithm(transformation, effectiveKey)
    this.key = Buffer.from(this.descriptor.keyBytes ?? effectiveKey)
    this.secretKey = Buffer.from(effectiveKey)
    const parsedIv = this.descriptor.ivRequired ? Buffer.from(iv ?? (() => { throw new Error(`${transformation} requires iv`) })()) : null
    if (this.descriptor.ivRequired && parsedIv !== null && parsedIv.length === 0) throw new Error(`${this.descriptor.algorithm} iv must not be empty`)
    if (this.descriptor.ivRequired && parsedIv !== null && this.descriptor.authMode === 'ccm' && (parsedIv.length < 7 || parsedIv.length > 13)) throw new Error(`${this.descriptor.algorithm} CCM iv must be 7..13 bytes`)
    if (this.descriptor.ivRequired && parsedIv !== null && this.descriptor.ivLength > 0 && parsedIv.length !== this.descriptor.ivLength) throw new Error(`${this.descriptor.algorithm} iv must be ${this.descriptor.ivLength} bytes`)
    this.iv = parsedIv
    this.encoding = encoding
  }

  public decrypt(input: Uint8Array): Uint8Array {
    const encrypted = Buffer.from(input)
    const tag = this.descriptor.authenticated ? encrypted.subarray(Math.max(0, encrypted.length - this.descriptor.authTagLength)) : undefined
    const ciphertext = tag === undefined ? encrypted : encrypted.subarray(0, encrypted.length - this.descriptor.authTagLength)
    if (tag !== undefined && encrypted.length < this.descriptor.authTagLength) throw new Error(`${this.descriptor.algorithm} ciphertext is missing authentication tag`)
    if (this.descriptor.authMode === 'ccm') {
      const decipher = createDecipheriv(this.descriptor.algorithm as CipherCCMTypes, this.key, this.iv, { authTagLength: this.descriptor.authTagLength } as unknown as TransformOptions) as CipherCCM & DecipherCCM
      decipher.setAuthTag(tag!)
      decipher.setAAD(Buffer.alloc(0), { plaintextLength: ciphertext.length })
      return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
    }
    if (this.descriptor.authMode === 'gcm') {
      const decipher = createDecipheriv(this.descriptor.algorithm as CipherGCMTypes, this.key, this.iv, { authTagLength: this.descriptor.authTagLength } as unknown as TransformOptions) as DecipherGCM
      decipher.setAuthTag(tag!)
      decipher.setAutoPadding(this.descriptor.autoPadding)
      return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
    }
    const decipher = createDecipheriv(this.descriptor.algorithm, this.key, this.iv)
    decipher.setAutoPadding(this.descriptor.autoPadding)
    return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  }

  public encrypt(input: Uint8Array): Uint8Array {
    if (this.descriptor.authMode === 'ccm') {
      const cipher = createCipheriv(this.descriptor.algorithm as CipherCCMTypes, this.key, this.iv, { authTagLength: this.descriptor.authTagLength } as unknown as TransformOptions) as CipherCCM
      cipher.setAAD(Buffer.alloc(0), { plaintextLength: input.byteLength })
      const output = Buffer.concat([cipher.update(Buffer.from(input)), cipher.final()])
      return Uint8Array.from(Buffer.concat([output, cipher.getAuthTag()]))
    }
    if (this.descriptor.authMode === 'gcm') {
      const cipher = createCipheriv(this.descriptor.algorithm as CipherGCMTypes, this.key, this.iv, { authTagLength: this.descriptor.authTagLength } as unknown as TransformOptions) as CipherGCM
      cipher.setAutoPadding(this.descriptor.autoPadding)
      const output = Buffer.concat([cipher.update(Buffer.from(input)), cipher.final()])
      return Uint8Array.from(Buffer.concat([output, cipher.getAuthTag()]))
    }
    const cipher = createCipheriv(this.descriptor.algorithm, this.key, this.iv)
    cipher.setAutoPadding(this.descriptor.autoPadding)
    return Uint8Array.from(Buffer.concat([cipher.update(Buffer.from(input)), cipher.final()]))
  }

  public decryptText(input: Uint8Array, charset = 'utf-8'): string {
    return this.encoding.decode(this.decrypt(input), charset)
  }

  public encryptText(input: string, charset = 'utf-8'): Uint8Array {
    return this.encrypt(this.encoding.encode(input, charset))
  }

  public setIv(iv: Uint8Array): SymmetricCrypto {
    const next = Buffer.from(iv)
    if (this.descriptor.ivRequired && next.length === 0) throw new Error(`${this.descriptor.algorithm} iv must not be empty`)
    if (this.descriptor.ivRequired && this.descriptor.authMode === 'ccm' && (next.length < 7 || next.length > 13)) throw new Error(`${this.descriptor.algorithm} CCM iv must be 7..13 bytes`)
    if (this.descriptor.ivRequired && this.descriptor.ivLength > 0 && next.length !== this.descriptor.ivLength) throw new Error(`${this.descriptor.algorithm} iv must be ${this.descriptor.ivLength} bytes`)
    this.iv = next
    return this
  }

  public getIv(): Uint8Array | undefined { return this.iv === null ? undefined : Uint8Array.from(this.iv) }

  public getSecretKey(): Uint8Array { return Uint8Array.from(this.secretKey) }
}

function keyBuffer(value: CryptoKeyInput): Buffer | string {
  if (typeof value === 'string' && value.includes('-----BEGIN')) return value
  return Buffer.from(value)
}

function rsaOptions(transformation: string): { padding: number; oaepHash?: string } {
  if (/NoPadding/iu.test(transformation)) return { padding: constants.RSA_NO_PADDING }
  if (/OAEP/iu.test(transformation)) {
    const hash = /SHA-(\d+)/iu.exec(transformation)?.[1] ?? /SHA(\d+)/iu.exec(transformation)?.[1]
    return { padding: constants.RSA_PKCS1_OAEP_PADDING, ...(hash === undefined ? {} : { oaepHash: `sha${hash}` }) }
  }
  return { padding: constants.RSA_PKCS1_PADDING }
}

function nodeSignAlgorithm(algorithm: string): string {
  const normalized = algorithm.replace(/\s+/gu, '')
  const rsa = /^SHA(\d+)withRSA$/iu.exec(normalized)
  if (rsa?.[1] !== undefined) return `RSA-SHA${rsa[1]}`
  const ecdsa = /^SHA(\d+)withECDSA$/iu.exec(normalized)
  if (ecdsa?.[1] !== undefined) return `SHA${ecdsa[1]}`
  return algorithm
}

class NodeAsymmetricCrypto implements AsymmetricCrypto {
  private privateKey: ReturnType<typeof createPrivateKey> | undefined
  private publicKey: ReturnType<typeof createPublicKey> | undefined
  private readonly transformation: string

  public constructor(transformation: string) {
    this.transformation = transformation
    if (!/^RSA(?:\/|$)/iu.test(transformation)) throw new Error(`unsupported asymmetric transformation: ${transformation}`)
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    this.privateKey = pair.privateKey
    this.publicKey = pair.publicKey
  }

  public setPrivateKey(key: CryptoKeyInput): AsymmetricCrypto {
    this.privateKey = createPrivateKey(typeof key === 'string' && key.includes('-----BEGIN') ? key : { key: keyBuffer(key), format: 'der', type: 'pkcs8' })
    return this
  }

  public setPublicKey(key: CryptoKeyInput): AsymmetricCrypto {
    this.publicKey = createPublicKey(typeof key === 'string' && key.includes('-----BEGIN') ? key : { key: keyBuffer(key), format: 'der', type: 'spki' })
    return this
  }

  public decrypt(input: Uint8Array, usePublicKey = true): Uint8Array {
    if (usePublicKey) {
      if (this.publicKey === undefined) throw new Error('public key is not set')
      return Uint8Array.from(publicDecrypt({ key: this.publicKey, ...rsaOptions(this.transformation) }, Buffer.from(input)))
    }
    if (this.privateKey === undefined) throw new Error('private key is not set')
    return Uint8Array.from(privateDecrypt({ key: this.privateKey, ...rsaOptions(this.transformation) }, Buffer.from(input)))
  }

  public encrypt(input: Uint8Array, usePublicKey = true): Uint8Array {
    if (usePublicKey) {
      if (this.publicKey === undefined) throw new Error('public key is not set')
      return Uint8Array.from(publicEncrypt({ key: this.publicKey, ...rsaOptions(this.transformation) }, Buffer.from(input)))
    }
    if (this.privateKey === undefined) throw new Error('private key is not set')
    return Uint8Array.from(privateEncrypt({ key: this.privateKey, ...rsaOptions(this.transformation) }, Buffer.from(input)))
  }

  public decryptText(input: Uint8Array, usePublicKey = true, charset = 'utf-8'): string {
    return new NodeEncodingHost().decode(this.decrypt(input, usePublicKey), charset)
  }

  public encryptHex(input: Uint8Array, usePublicKey = true): string {
    return Buffer.from(this.encrypt(input, usePublicKey)).toString('hex')
  }

  public encryptBase64(input: Uint8Array, usePublicKey = true): string {
    return Buffer.from(this.encrypt(input, usePublicKey)).toString('base64')
  }
}

class NodeSignCrypto implements SignCrypto {
  private privateKey: ReturnType<typeof createPrivateKey> | undefined
  private publicKey: ReturnType<typeof createPublicKey> | undefined
  private readonly algorithm: string

  public constructor(algorithm: string) {
    this.algorithm = nodeSignAlgorithm(algorithm)
  }

  public setPrivateKey(key: CryptoKeyInput): SignCrypto {
    this.privateKey = createPrivateKey(typeof key === 'string' && key.includes('-----BEGIN') ? key : { key: keyBuffer(key), format: 'der', type: 'pkcs8' })
    return this
  }

  public setPublicKey(key: CryptoKeyInput): SignCrypto {
    this.publicKey = createPublicKey(typeof key === 'string' && key.includes('-----BEGIN') ? key : { key: keyBuffer(key), format: 'der', type: 'spki' })
    return this
  }

  public sign(input: Uint8Array): Uint8Array {
    if (this.privateKey === undefined) throw new Error('private key is not set')
    const signer = createSign(this.algorithm)
    signer.update(Buffer.from(input))
    return Uint8Array.from(signer.sign(this.privateKey))
  }

  public signHex(input: Uint8Array): string { return Buffer.from(this.sign(input)).toString('hex') }

  public signBase64(input: Uint8Array): string { return Buffer.from(this.sign(input)).toString('base64') }

  public verify(input: Uint8Array, signature: Uint8Array): boolean {
    if (this.publicKey === undefined) throw new Error('public key is not set')
    const verifier = createVerify(this.algorithm)
    verifier.update(Buffer.from(input))
    return verifier.verify(this.publicKey, Buffer.from(signature))
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

  public createSymmetricCrypto(transformation: string, key?: Uint8Array, iv?: Uint8Array): SymmetricCrypto {
    return new NodeSymmetricCrypto(transformation, key, iv, this.encoding)
  }

  public generateSymmetricKey(transformation: string): Uint8Array {
    return Uint8Array.from(randomBytes(generatedKeyLength(transformation)))
  }

  public createAsymmetricCrypto(transformation: string): AsymmetricCrypto {
    return new NodeAsymmetricCrypto(transformation)
  }

  public createSign(algorithm: string): SignCrypto {
    return new NodeSignCrypto(algorithm)
  }
}
