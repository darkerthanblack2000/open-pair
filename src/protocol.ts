/**
 * protocol.ts — payload encode/decode with optional AES-256-GCM encryption.
 *
 * Wire format (encrypted):  [12-byte nonce][ciphertext][16-byte GCM auth tag]
 * Wire format (plaintext):  raw UTF-8 JSON string
 *
 * These functions work on raw payloads (bytes inside a WS frame or TCP frame).
 * Framing is handled by transport.ts.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const NONCE_LEN = 12
const TAG_LEN   = 16

export type LiveShareMessage = Record<string, unknown> & { t: string }

export function encode(msg: LiveShareMessage, key?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8')
  if (!key) {
    return json
  }
  const nonce  = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct     = Buffer.concat([cipher.update(json), cipher.final()])
  const tag    = cipher.getAuthTag()
  return Buffer.concat([nonce, ct, tag])
}

export function decode(payload: Buffer, key?: Buffer): LiveShareMessage | null {
  let jsonBuf: Buffer
  if (key) {
    if (payload.length < NONCE_LEN + TAG_LEN) {
      return null
    }
    const nonce  = payload.subarray(0, NONCE_LEN)
    const tag    = payload.subarray(payload.length - TAG_LEN)
    const ct     = payload.subarray(NONCE_LEN, payload.length - TAG_LEN)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      jsonBuf = Buffer.concat([decipher.update(ct), decipher.final()])
    } catch {
      return null
    }
  } else {
    jsonBuf = payload
  }

  try {
    const msg = JSON.parse(jsonBuf.toString('utf8'))
    if (msg && typeof msg === 'object' && typeof msg.t === 'string') {
      return msg as LiveShareMessage
    }
  } catch {
    // fall through
  }
  return null
}
