/**
 * transport.ts — WebSocket and raw TCP transports.
 *
 * Both expose the same interface:
 *   send(payload: Buffer): void
 *   on('message', cb: (payload: Buffer) => void): void
 *   on('close',   cb: () => void): void
 *   on('error',   cb: (err: Error) => void): void
 *   close(): void
 *
 * WebSocket mode:  client→server frames are masked (RFC 6455 §5.3).
 *                  Uses the `ws` npm package.
 * Raw TCP mode:    each message is prefixed with a 4-byte little-endian length.
 */

import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import WebSocket from 'ws'

export interface Transport extends EventEmitter {
  send(payload: Buffer): void
  close(): void
}

// ── WebSocket transport ──────────────────────────────────────────────────────

export function createWsTransport(host: string, port: number): Transport {
  const emitter = new EventEmitter() as Transport
  const url     = `ws://${host}:${port}`
  const ws      = new WebSocket(url)

  ws.binaryType = 'nodebuffer'

  // Send WS ping frames every 25s to prevent tunnel idle-timeout during
  // the host approval window (typical tunnel timeout: 30-60s).
  let pingTimer: ReturnType<typeof setInterval> | undefined

  ws.on('open', () => {
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, 25000)
    emitter.emit('open')
  })

  ws.on('message', (data: Buffer) => {
    emitter.emit('message', data)
  })

  ws.on('close', (code: number, reason: Buffer) => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined }
    emitter.emit('close', code, reason.toString())
  })

  ws.on('error', (err: Error) => {
    emitter.emit('error', err)
  })

  emitter.send = (payload: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  }

  emitter.close = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }

  return emitter
}

// ── Raw TCP transport ────────────────────────────────────────────────────────

export function createTcpTransport(host: string, port: number): Transport {
  const emitter = new EventEmitter() as Transport
  const socket  = new net.Socket()
  let   buf     = Buffer.alloc(0)

  socket.connect(port, host, () => {
    emitter.emit('open')
  })

  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) {
        break
      }
      const payload = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      emitter.emit('message', payload)
    }
  })

  socket.on('close', () => {
    emitter.emit('close')
  })

  socket.on('error', (err: Error) => {
    emitter.emit('error', err)
  })

  emitter.send = (payload: Buffer) => {
    if (!socket.destroyed) {
      const header = Buffer.allocUnsafe(4)
      header.writeUInt32LE(payload.length, 0)
      socket.write(Buffer.concat([header, payload]))
    }
  }

  emitter.close = () => {
    if (!socket.destroyed) {
      socket.destroy()
    }
  }

  return emitter
}
