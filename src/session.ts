/**
 * session.ts — guest session state machine.
 *
 * Responsibilities:
 *   - Parse the share URL (extract key, detect ws vs tcp mode)
 *   - Connect via the appropriate transport
 *   - Drive the connection flow: connect → hello → hello_ack → live
 *   - Dispatch incoming messages to registered handlers
 *   - Send messages to the host
 *   - Clean shutdown
 */

import * as vscode from 'vscode'
import { encode, decode, LiveShareMessage, PROTOCOL_VERSION } from './protocol'
import { createWsTransport, createTcpTransport, Transport } from './transport'

export type SessionRole = 'rw' | 'ro'
export type MessageHandler = (msg: LiveShareMessage) => void

// Capabilities this client implements.
const SUPPORTED_CAPS = new Set(['workspace', 'terminal', 'cursor', 'follow'])

export interface ParsedUrl {
  host: string
  port: number
  key: Buffer | undefined
  mode: 'ws' | 'tcp' | 'punch'
}

export function parseShareUrl(raw: string): ParsedUrl {
  const keyMatch = raw.match(/#key=([A-Za-z0-9_-]+)/)
  const key      = keyMatch ? Buffer.from(keyMatch[1], 'base64url') : undefined
  const url      = raw.replace(/#.*$/, '').trim()

  // §1.3: Punch P2P UDP transport — signaling flow not supported yet
  if (url.startsWith('punch+')) {
    return { host: '', port: 0, key, mode: 'punch' }
  }

  if (url.startsWith('tcp://')) {
    const rest  = url.slice(6)
    const colon = rest.lastIndexOf(':')
    return {
      host: rest.slice(0, colon),
      port: parseInt(rest.slice(colon + 1), 10),
      key,
      mode: 'tcp',
    }
  }

  const clean    = url.replace(/^https?:\/\//, '')
  const colonIdx = clean.lastIndexOf(':')
  if (colonIdx > 0 && /^\d+$/.test(clean.slice(colonIdx + 1))) {
    return {
      host: clean.slice(0, colonIdx),
      port: parseInt(clean.slice(colonIdx + 1), 10),
      key,
      mode: 'ws',
    }
  }

  return { host: clean, port: 80, key, mode: 'ws' }
}

export type SessionLogger = (msg: string) => void

export class Session {
  // Filled after hello
  sid      : string | undefined
  peerId   : number | undefined
  role     : SessionRole | undefined
  hostRequiredCaps : string[] = []
  hostOptionalCaps : string[] = []

  private transport        : Transport | undefined
  private key              : Buffer | undefined
  private handlers         : MessageHandler[] = []
  private _connected       = false
  private intentionalClose = false
  private parsed           : ParsedUrl | undefined
  private displayName      : string = ''
  private log              : SessionLogger = () => {}

  get connected(): boolean { return this._connected }
  get transportMode(): 'ws' | 'tcp' | 'punch' | undefined { return this.parsed?.mode }

  setLogger(logger: SessionLogger): void {
    this.log = logger
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler)
  }

  connect(parsed: ParsedUrl, displayName: string): void {
    if (parsed.mode === 'punch') {
      vscode.window.showErrorMessage(
        'Live Share: Punch (P2P UDP) transport is not supported — use a WS or TCP URL'
      )
      return
    }
    if (!parsed.key) {
      vscode.window.showErrorMessage(
        'Live Share: no encryption key found in URL (#key=…) — refusing to connect without encryption'
      )
      return
    }
    this.parsed           = parsed
    this.displayName      = displayName
    this.key              = parsed.key
    this.intentionalClose = false
    this.doConnect()
  }

  private doConnect(): void {
    if (!this.parsed) { return }
    const t = this.parsed.mode === 'tcp'
      ? createTcpTransport(this.parsed.host, this.parsed.port)
      : createWsTransport(this.parsed.host, this.parsed.port)
    this.transport = t

    t.on('open', () => {
      this.log(`transport open (${this.parsed?.mode ?? '?'}) → sending connect`)
      // §8: send connect as first protocol message after transport is up
      this.send({ t: 'connect' })
    })

    t.on('message', (payload: Buffer) => {
      const msg = decode(payload, this.key)
      if (!msg) {
        this.log(`message received (${payload.length} bytes) — decryption failed (wrong key or corrupt frame)`)
        return
      }
      this.log(`message received: t=${msg.t}`)

      if (msg.t === 'hello') {
        const remoteVersion = msg['protocol_version'] as number | undefined
        if (remoteVersion !== undefined && remoteVersion !== PROTOCOL_VERSION) {
          vscode.window.showWarningMessage(
            `Live Share: protocol version mismatch (host=${remoteVersion}, ours=${PROTOCOL_VERSION}) — behaviour may be undefined`
          )
        }
        const requiredCaps  = (msg['required_caps'] as string[] | undefined) ?? []
        const unsupported   = requiredCaps.filter(c => !SUPPORTED_CAPS.has(c))
        if (unsupported.length > 0) {
          vscode.window.showErrorMessage(
            `Live Share: host requires unsupported capabilities: ${unsupported.join(', ')} — disconnecting`
          )
          this.dispose()
          return
        }
        this.sid              = msg['sid']    as string
        this.peerId           = msg['peer_id'] as number
        this.role             = (msg['role'] as SessionRole) ?? 'rw'
        this.hostRequiredCaps = requiredCaps
        this.hostOptionalCaps = (msg['optional_caps'] as string[] | undefined) ?? []
        this._connected = true
        this.send({ t: 'hello_ack', name: this.displayName, caps: [...SUPPORTED_CAPS] })
        this.log(`hello OK — peer_id=${this.peerId} sid=${this.sid} role=${this.role}`)
      }

      if (msg.t === 'rejected') {
        const reason = (msg['reason'] as string | undefined) ?? 'no reason given'
        vscode.window.showErrorMessage(`Live Share: connection rejected — ${reason}`)
        this.dispose()
        return
      }

      if (msg.t === 'error') {
        const code    = (msg['code']    as string | undefined) ?? 'unknown'
        const message = (msg['message'] as string | undefined) ?? ''
        vscode.window.showErrorMessage(`Live Share: host error [${code}] ${message}`)
        return
      }

      for (const h of this.handlers) { h(msg) }
    })

    t.on('close', (code?: number, reason?: string) => {
      const detail = code !== undefined ? ` (code ${code}${reason ? ': ' + reason : ''})` : ''
      this.log(`transport closed${detail}`)
      this._connected = false
      this.transport  = undefined

      // §7.3: session URLs are single-use — do not auto-reconnect after disconnect
      if (!this.intentionalClose) {
        vscode.window.showErrorMessage(
          `Live Share: disconnected${detail} — rejoin manually with a new URL`,
          'Dismiss'
        )
        for (const h of this.handlers) { h({ t: 'bye', peer: 0 }) }
      }
    })

    t.on('error', (err: Error) => {
      this.log(`transport error — ${err.message}`)
      vscode.window.showErrorMessage(`Live Share: connection error — ${err.message}`)
      this._connected = false
    })
  }

  send(msg: LiveShareMessage): void {
    if (!this.transport) { return }
    try {
      const payload = encode(msg, this.key)
      this.transport.send(payload)
    } catch (err) {
      console.error('live-share: encode error', err)
    }
  }

  dispose(): void {
    this.intentionalClose = true
    if (this._connected) {
      try { this.send({ t: 'bye' }) } catch { /* ignore */ }
    }
    this.transport?.close()
    this.transport  = undefined
    this._connected = false
    this.sid        = undefined
    this.peerId     = undefined
    this.role       = undefined
    this.hostRequiredCaps = []
    this.hostOptionalCaps = []
    this.handlers   = []
  }
}
