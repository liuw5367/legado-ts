import iconv from 'iconv-lite'
import type { CharsetCodec } from '@legado/source-core'

function normalizeCharset(charset: string): string {
  return charset.trim().toLowerCase().replace(/[_\s]/g, '-')
}

export class NodeCharsetCodec implements CharsetCodec {
  public encode(text: string, charset: string): Uint8Array {
    const normalized = normalizeCharset(charset)
    if (!iconv.encodingExists(normalized)) throw new Error(`unsupported charset: ${charset}`)
    return Uint8Array.from(iconv.encode(text, normalized))
  }

  public decode(bytes: Uint8Array, charset: string): string {
    const normalized = normalizeCharset(charset)
    if (!iconv.encodingExists(normalized)) throw new Error(`unsupported charset: ${charset}`)
    return iconv.decode(Buffer.from(bytes), normalized)
  }
}
