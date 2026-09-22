import type { EncodingHost } from '@legado/source-core'
import { NodeCharsetCodec } from './charset.ts'

function bytesFromString(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function assertHex(value: string): void {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) throw new Error('invalid hexadecimal input')
}

export class NodeEncodingHost extends NodeCharsetCodec implements EncodingHost {
  public base64Encode(input: string | Uint8Array): string {
    return Buffer.from(typeof input === 'string' ? bytesFromString(input) : input).toString('base64')
  }

  public base64Decode(value: string): Uint8Array {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error('invalid Base64 input')
    const decoded = Buffer.from(value, 'base64')
    if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw new Error('invalid Base64 input')
    return Uint8Array.from(decoded)
  }

  public hexEncode(input: Uint8Array): string {
    return Buffer.from(input).toString('hex')
  }

  public hexDecode(value: string): Uint8Array {
    assertHex(value)
    return Uint8Array.from(Buffer.from(value, 'hex'))
  }

  public encodeUri(value: string): string {
    return encodeURI(value)
  }

  public decodeUri(value: string): string {
    return decodeURI(value)
  }
}
