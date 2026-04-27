/**
 * host.ts — VS Code as Live Share host (server).
 *
 * Architecture mirrors Neovim's collab/server.lua + host.lua:
 *   - TCP server that auto-detects WebSocket vs raw TCP from first 4 bytes
 *   - WebSocket HTTP upgrade handshake (server-side, SHA-1 via node:crypto)
 *   - Two-stage approval: connect → VS Code dialog → hello + workspace snapshot
 *   - Watches open VS Code documents and broadcasts patches/focus/cursor to guests
 *   - Applies guest patches via WorkspaceEdit with an applying guard
 *
 * Frame helpers (server side):
 *   - Sends UNMASKED WebSocket frames
 *   - Receives MASKED WebSocket frames from clients (and unmasks them)
 *   - Raw TCP: 4-byte little-endian length prefix
 */

import * as net    from 'node:net'
import * as crypto from 'node:crypto'
import * as os     from 'node:os'
import * as vscode from 'vscode'
import { encode, decode, LiveShareMessage, PROTOCOL_VERSION } from './protocol'
import { PeerTracker } from './peers'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ── Frame helpers ────────────────────────────────────────────────────────────

function wsAccept(clientKey: string): string {
  return crypto.createHash('sha1').update(clientKey + WS_GUID).digest('base64')
}

function encodeWsFrame(payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x82, len])
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x82; header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x82; header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

function decodeWsFrames(buf: Buffer): { payloads: Buffer[]; rest: Buffer } {
  const payloads: Buffer[] = []
  let i = 0
  while (i + 2 <= buf.length) {
    const b1 = buf[i], b2 = buf[i + 1]
    const opcode  = b1 & 0x0f
    const masked  = (b2 & 0x80) !== 0
    const plen7   = b2 & 0x7f
    let extLen = 0, plen = plen7
    if (plen7 === 126) {
      if (i + 4 > buf.length) break
      extLen = 2; plen = buf.readUInt16BE(i + 2)
    } else if (plen7 === 127) {
      if (i + 10 > buf.length) break
      extLen = 8; plen = Number(buf.readBigUInt64BE(i + 2))
    }
    const maskSize = masked ? 4 : 0
    const hdrSize  = 2 + extLen + maskSize
    if (i + hdrSize + plen > buf.length) break
    let payload = buf.subarray(i + 2 + extLen + maskSize, i + hdrSize + plen)
    if (masked) {
      const mk  = buf.subarray(i + 2 + extLen, i + 2 + extLen + 4)
      const out = Buffer.allocUnsafe(plen)
      for (let j = 0; j < plen; j++) out[j] = payload[j] ^ mk[j % 4]
      payload = out
    }
    if (opcode === 1 || opcode === 2) payloads.push(payload)
    i += hdrSize + plen
  }
  return { payloads, rest: buf.subarray(i) }
}

function encodeTcpFrame(payload: Buffer): Buffer {
  const hdr = Buffer.allocUnsafe(4)
  hdr.writeUInt32LE(payload.length, 0)
  return Buffer.concat([hdr, payload])
}

function decodeTcpFrames(buf: Buffer): { payloads: Buffer[]; rest: Buffer } {
  const payloads: Buffer[] = []
  let i = 0
  while (i + 4 <= buf.length) {
    const len = buf.readUInt32LE(i)
    if (i + 4 + len > buf.length) break
    payloads.push(buf.subarray(i + 4, i + 4 + len))
    i += 4 + len
  }
  return { payloads, rest: buf.subarray(i) }
}

// ── Workspace helpers ────────────────────────────────────────────────────────

function getLocalIp(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

function isShareable(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file'
    && !doc.isUntitled
    && !!vscode.workspace.getWorkspaceFolder(doc.uri)
}

function getRelPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'file') return undefined
  const rel = vscode.workspace.asRelativePath(uri, false)
  // asRelativePath returns the fsPath unchanged if the file is outside any workspace folder.
  // Normalize to forward slashes so paths match on Windows hosts and cross-platform guests.
  return rel === uri.fsPath ? undefined : rel.replace(/\\/g, '/')
}

function docToLines(doc: vscode.TextDocument): string[] {
  const lines: string[] = []
  for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text)
  return lines
}

function decodeBytesToText(bytes: Uint8Array): string {
  // BOM-based detection
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE)
    return new TextDecoder('utf-16le').decode(bytes)
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF)
    return new TextDecoder('utf-16be').decode(bytes)

  // BOM-less UTF-16 LE heuristic: sample up to 256 bytes and check whether
  // odd-indexed bytes are overwhelmingly 0x00 (ASCII chars encoded as XX 00).
  const sample = Math.min(bytes.length, 256)
  if (sample >= 8) {
    let nullsAtOdd = 0
    for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) nullsAtOdd++
    if (nullsAtOdd / (sample / 2) > 0.6)
      return new TextDecoder('utf-16le').decode(bytes)
  }

  // UTF-8 (with or without BOM — TextDecoder strips it automatically)
  return new TextDecoder('utf-8').decode(bytes)
}

async function scanWorkspaceFiles(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    '**/*',
    '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.vscode/**}',
    10_000,
  )
  const files: string[] = []
  for (const uri of uris) {
    const rel = getRelPath(uri)
    if (rel) files.push(rel)
  }
  return files.sort()
}

// ── Peer state ───────────────────────────────────────────────────────────────

interface PeerConn {
  socket: net.Socket
  mode  : 'ws' | 'tcp'
  role  : 'rw' | 'ro'
  name  : string
  buf   : Buffer
}

// ── Host class ────────────────────────────────────────────────────────────────

export type HostLogger = (msg: string) => void

export class Host {
  private server     : net.Server | undefined
  private clients    = new Map<number, PeerConn>()
  private pending    = new Map<number, { socket: net.Socket; mode: 'ws'|'tcp'; buf: Buffer }>()
  private nextId     = 1
  private sessionKey : Buffer
  private sid        : string
  private seq        = 0
  // Paths where we are currently applying a guest patch (suppress echo-back)
  private applyingFor = new Set<string>()
  private disposables: vscode.Disposable[] = []
  private _port      = 9876
  private log        : HostLogger = () => {}

  constructor(
    private readonly displayName: string,
    readonly peers: PeerTracker,
    private readonly onPeerJoin   : (peerId: number) => void,
    private readonly onPeerLeave  : (peerId: number, name: string) => void,
    private readonly onGuestCursor?: (peerId: number, msg: LiveShareMessage) => void,
  ) {
    this.sessionKey = crypto.randomBytes(32)
    this.sid        = crypto.randomBytes(8).toString('hex')
  }

  setLogger(logger: HostLogger): void {
    this.log = logger
  }

  /** Local-only share URL (bare host:port, no tunnel). */
  get shareUrl(): string {
    const ip  = getLocalIp()
    const key = this.sessionKey.toString('base64url')
    // Use bare host:port (no tcp:// scheme) so Neovim parses it as WebSocket mode
    // and sends the HTTP upgrade immediately on connect. With tcp://, Neovim enters
    // raw TCP mode and waits for the server to speak first — causing a deadlock because
    // this host also waits for the client's first bytes to detect the transport.
    return `${ip}:${this._port}#key=${key}`
  }

  /** The `#key=<base64url>` fragment to append to any tunnel URL. */
  get keyFragment(): string {
    return `#key=${this.sessionKey.toString('base64url')}`
  }

  get port(): number { return this._port }
  get guestCount(): number { return this.clients.size }
  get sessionId(): string { return this.sid }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(port: number): void {
    this._port  = port
    this.server = net.createServer(socket => this.onConnect(socket))
    // Omit the hostname so Node.js binds to '::' (dual-stack IPv4+IPv6) when
    // IPv6 is available, falling back to '0.0.0.0' otherwise.  On Windows the
    // SSH reverse-tunnel client may resolve 'localhost' to '::1', so we must
    // accept IPv6 connections or the tunnel forward silently fails.
    this.server.listen(port, () => {
      const addr    = this.server?.address()
      const addrStr = typeof addr === 'object' && addr
        ? `${addr.address}:${addr.port}` : String(addr)
      this.log(`server listening on ${addrStr}`)
      console.log(`live-share host: listening on ${addrStr}`)
    })
    this.server.on('error', (err: Error) => {
      vscode.window.showErrorMessage(`Live Share: server error — ${err.message}`)
    })
    this.setupWatchers()
  }

  stop(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []

    // Send bye to all connected peers
    this.broadcast({ t: 'bye', peer: 0, name: this.displayName })

    for (const c of this.clients.values()) {
      if (!c.socket.destroyed) c.socket.destroy()
    }
    for (const p of this.pending.values()) {
      if (!p.socket.destroyed) p.socket.destroy()
    }
    this.clients.clear()
    this.pending.clear()

    this.server?.close()
    this.server = undefined
  }

  send(peerId: number, msg: LiveShareMessage): void {
    const c = this.clients.get(peerId)
    if (!c || c.socket.destroyed) return
    const frame = this.encodeFor(c, msg)
    if (frame) c.socket.write(frame)
  }

  broadcast(msg: LiveShareMessage, exceptPeer?: number): void {
    for (const [pid, c] of this.clients) {
      if (pid === exceptPeer || c.socket.destroyed) continue
      const frame = this.encodeFor(c, msg)
      if (frame) c.socket.write(frame)
    }
  }

  // ── New connection handling ────────────────────────────────────────────────

  private onConnect(socket: net.Socket): void {
    const peerId = this.nextId++
    let buf      = Buffer.alloc(0)
    let detected = false

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`
    this.log(`peer ${peerId}: TCP connection accepted from ${remoteAddr}`)

    // Raw TCP clients (ngrok tcp://) never send data first — they wait for the
    // server's hello. If no bytes arrive within 600 ms, assume raw TCP mode and
    // kick off the approval flow so the server speaks first.
    const detectTimer = setTimeout(() => {
      if (detected) return
      detected = true
      this.log(`peer ${peerId}: no data after 600ms — assuming raw TCP mode`)
      this.pending.set(peerId, { socket, mode: 'tcp', buf: Buffer.alloc(0) })
      void this.promptApproval(peerId)
    }, 600)

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])

      if (!detected) {
        if (buf.length < 4) return   // need at least 4 bytes to detect mode
        detected = true
        clearTimeout(detectTimer)

        const prefix = buf.subarray(0, 4).toString('ascii')
        this.log(`peer ${peerId}: first 4 bytes = ${JSON.stringify(prefix)} (${buf.length} bytes total) — ${prefix === 'GET ' ? 'WebSocket mode' : 'raw TCP mode'}`)

        if (prefix === 'GET ') {
          // WebSocket mode
          this.handleWsHandshake(peerId, socket, buf)
        } else {
          // Raw TCP mode — data arrived before the timer fired
          this.pending.set(peerId, { socket, mode: 'tcp', buf: Buffer.alloc(0) })
          void this.promptApproval(peerId)
          this.handleTcpData(peerId, buf)
          buf = Buffer.alloc(0)
        }
        return
      }

      // After detection, data continues in mode-specific handlers
      // (ws and tcp handlers update buf directly via closure or re-route)
    })

    socket.on('error', (err: Error) => {
      this.log(`peer ${peerId}: socket error — ${err.message}`)
      clearTimeout(detectTimer)
      this.cleanupPeer(peerId)
    })

    socket.on('close', () => {
      clearTimeout(detectTimer)
      const wasClient = this.clients.has(peerId)
      const name = this.clients.get(peerId)?.name ?? ''
      this.cleanupPeer(peerId)
      if (wasClient) {
        this.broadcast({ t: 'bye', peer: peerId, name }, peerId)
        this.onPeerLeave(peerId, name)
        this.peers.remove(peerId)
      }
    })
  }

  // ── WebSocket handshake ────────────────────────────────────────────────────

  private handleWsHandshake(peerId: number, socket: net.Socket, initial: Buffer): void {
    let hsBuf = initial
    let done  = false

    const tryHandshake = () => {
      const end = hsBuf.indexOf('\r\n\r\n')
      if (end === -1) return  // need more data

      done = true

      const headers = hsBuf.subarray(0, end).toString('utf8')
      const rest    = hsBuf.subarray(end + 4)

      const keyMatch = headers.match(/[Ss]ec-[Ww]eb[Ss]ocket-[Kk]ey:\s*(\S+)/i)
      if (!keyMatch) {
        const preview = headers.slice(0, 400)
        this.log(`peer ${peerId}: WS handshake failed — Sec-WebSocket-Key not found\nHeaders:\n${preview}`)
        vscode.window.showErrorMessage(
          `Live Share: WS handshake failed (Sec-WebSocket-Key missing) — check "Live Share — Debug Info" output for headers`
        )
        socket.write(
          'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        )
        setTimeout(() => { if (!socket.destroyed) socket.destroy() }, 200)
        return
      }

      const accept   = wsAccept(keyMatch[1].trim())
      this.log(`peer ${peerId}: WS handshake OK (key=${keyMatch[1].trim().slice(0, 8)}…) — sending 101`)
      const response = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '', '',
      ].join('\r\n')
      socket.write(response)

      // Switch to WS frame mode
      this.pending.set(peerId, { socket, mode: 'ws', buf: rest })
      void this.promptApproval(peerId)

      // Re-route future data to WS handler
      socket.removeAllListeners('data')
      socket.on('data', (chunk: Buffer) => this.handleWsData(peerId, chunk))
      if (rest.length > 0) this.handleWsData(peerId, Buffer.alloc(0))
    }

    tryHandshake()
    // Only install the "waiting for more headers" listener if the handshake headers
    // weren't already complete in the initial buffer. If tryHandshake() already ran
    // to completion above, it has already installed the correct handleWsData listener;
    // overwriting it here with a tryHandshake-listener would cause all subsequent
    // WS frames to be misinterpreted as HTTP headers and silently discarded.
    if (!done) {
      socket.removeAllListeners('data')
      socket.on('data', (chunk: Buffer) => {
        hsBuf = Buffer.concat([hsBuf, chunk])
        tryHandshake()
      })
    }
  }

  private handleWsData(peerId: number, chunk: Buffer): void {
    const entry = this.pending.get(peerId) ?? this.clients.get(peerId)
    if (!entry) return

    entry.buf = Buffer.concat([entry.buf, chunk])
    const { payloads, rest } = decodeWsFrames(entry.buf)
    entry.buf = rest

    for (const payload of payloads) {
      const msg = decode(payload, this.sessionKey)
      if (msg) this.dispatch(msg, peerId)
    }
  }

  private handleTcpData(peerId: number, chunk: Buffer): void {
    const entry = this.pending.get(peerId) ?? this.clients.get(peerId)
    if (!entry) return

    entry.buf = Buffer.concat([entry.buf, chunk])
    const { payloads, rest } = decodeTcpFrames(entry.buf)
    entry.buf = rest

    for (const payload of payloads) {
      const msg = decode(payload, this.sessionKey)
      if (msg) this.dispatch(msg, peerId)
    }
  }

  // ── Approval flow ─────────────────────────────────────────────────────────

  private async promptApproval(peerId: number): Promise<void> {
    // Re-route data while waiting for approval
    const p = this.pending.get(peerId)
    if (!p) return
    const { socket, mode } = p

    this.log(`peer ${peerId}: showing approval dialog (mode=${mode})`)
    socket.removeAllListeners('data')
    socket.on('data', (chunk: Buffer) => {
      if (mode === 'ws') this.handleWsData(peerId, chunk)
      else               this.handleTcpData(peerId, chunk)
    })

    const choice = await vscode.window.showInformationMessage(
      `Live Share: guest wants to join`,
      { modal: false },
      'Allow (R/W)', 'Allow (Read Only)', 'Deny',
    )

    if (!this.pending.has(peerId)) {
      this.log(`peer ${peerId}: disconnected while waiting for approval`)
      return
    }

    this.log(`peer ${peerId}: approval result = ${choice ?? '(dismissed)'}`)

    if (!choice || choice === 'Deny') {
      const frame = this.encodeRaw(p.mode, { t: 'rejected', reason: 'Host denied the connection' })
      if (frame && !socket.destroyed) {
        socket.write(frame)
        setTimeout(() => { if (!socket.destroyed) socket.destroy() }, 200)
      } else if (!socket.destroyed) {
        socket.destroy()
      }
      this.pending.delete(peerId)
      return
    }

    const role: 'rw' | 'ro' = choice === 'Allow (Read Only)' ? 'ro' : 'rw'
    await this.approvePeer(peerId, role)
  }

  private async approvePeer(peerId: number, role: 'rw' | 'ro'): Promise<void> {
    const p = this.pending.get(peerId)
    if (!p) return
    this.pending.delete(peerId)

    const client: PeerConn = { socket: p.socket, mode: p.mode, role, name: '', buf: p.buf }
    this.clients.set(peerId, client)

    // Send hello first so the guest knows the session is accepted
    this.send(peerId, {
      t                : 'hello',
      protocol_version : PROTOCOL_VERSION,
      sid              : this.sid,
      peer_id          : peerId,
      host_name        : this.displayName,
      role,
      required_caps    : ['workspace'],
      optional_caps    : ['terminal', 'cursor', 'follow'],
    })

    // Send open_files_snapshot BEFORE the slow workspace scan.
    // Neovim starts a 10-second watchdog on hello that is cancelled ONLY by
    // open_files_snapshot — not by workspace_info. Always send it (empty is fine)
    // so the watchdog is cancelled before scanWorkspaceFiles() can time it out.
    const openFiles: { path: string; lines: string[] }[] = []
    for (const doc of vscode.workspace.textDocuments) {
      const path = getRelPath(doc.uri)
      if (path && isShareable(doc)) openFiles.push({ path, lines: docToLines(doc) })
    }
    this.send(peerId, { t: 'open_files_snapshot', files: openFiles })

    // Snapshot of connected peers
    const peerList = this.peers.getAll()
    if (peerList.length > 0) {
      this.send(peerId, { t: 'peers_snapshot', peers: peerList })
    }

    // Scan all workspace files (async) — can be slow on large workspaces;
    // send after open_files_snapshot so Neovim's watchdog is already cancelled.
    const wsFolder = vscode.workspace.workspaceFolders?.[0]
    const files    = await scanWorkspaceFiles()
    this.send(peerId, {
      t        : 'workspace_info',
      root_name: wsFolder?.name ?? 'workspace',
      files,
    })

    // Tell other guests about the new peer (will be named once hello_ack arrives)
    this.broadcast({ t: 'peers_snapshot', peers: [{ peer_id: peerId, name: `guest ${peerId}` }] }, peerId)

    this.onPeerJoin(peerId)
  }

  // ── Message dispatch from guests ──────────────────────────────────────────

  private dispatch(msg: LiveShareMessage, fromPeer: number): void {
    // Messages from pending peers (before approval) are dropped except hello_ack
    if (!this.clients.has(fromPeer)) return

    const client = this.clients.get(fromPeer)!

    switch (msg.t) {
      case 'hello_ack': {
        const name = (msg['name'] as string | undefined) || `guest ${fromPeer}`
        client.name = name
        this.peers.upsert(fromPeer, { name, role: client.role })
        const caps = msg['caps'] as string[] | undefined
        console.log(`live-share: ${name} caps: ${caps?.join(', ') ?? 'none'}`)
        vscode.window.showInformationMessage(`Live Share: ${name} joined [${client.role}]`)
        // Broadcast updated peer info to all other guests
        this.broadcast({ t: 'peers_snapshot', peers: [{ peer_id: fromPeer, name }] }, fromPeer)
        break
      }

      case 'patch': {
        if (client.role === 'ro') break  // enforce read-only server-side
        const path  = msg['path']  as string
        const lnum  = msg['lnum']  as number
        const count = msg['count'] as number
        const lines = (msg['lines'] as string[] | undefined) ?? []
        void this.applyGuestPatch(path, lnum, count, lines, fromPeer)
        break
      }

      case 'cursor': {
        const path = msg['path'] as string
        this.peers.upsert(fromPeer, { activePath: path })
        this.broadcast({ ...msg, peer: fromPeer }, fromPeer)
        this.onGuestCursor?.(fromPeer, msg)
        break
      }

      case 'focus': {
        const path = msg['path'] as string
        const name = msg['name'] as string | undefined
        this.peers.upsert(fromPeer, { activePath: path, ...(name ? { name } : {}) })
        this.broadcast({ t: 'focus', path, peer: fromPeer, name }, fromPeer)
        break
      }

      case 'file_request': {
        const path  = msg['path']   as string
        const reqId = msg['req_id'] as number | undefined
        void this.respondToFileRequest(fromPeer, path, reqId)
        break
      }

      case 'bye': {
        const name = (msg['name'] as string | undefined) ?? client.name
        this.broadcast({ t: 'bye', peer: fromPeer, name }, fromPeer)
        this.peers.remove(fromPeer)
        this.cleanupPeer(fromPeer)
        this.onPeerLeave(fromPeer, name)
        vscode.window.showInformationMessage(`Live Share: ${name} left`)
        break
      }
    }
  }

  // ── Respond to file request from guest ───────────────────────────────────

  private async respondToFileRequest(peerId: number, path: string, reqId: number | undefined): Promise<void> {
    // First try an already-open document (authoritative in-memory state)
    const doc = vscode.workspace.textDocuments.find(d => getRelPath(d.uri) === path)
    if (doc) {
      this.send(peerId, { t: 'file_response', path, lines: docToLines(doc), readonly: false, req_id: reqId })
      return
    }

    // Fall back to reading from disk
    const wsFolder = vscode.workspace.workspaceFolders?.[0]
    if (wsFolder) {
      const fileUri = vscode.Uri.joinPath(wsFolder.uri, path)
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri)
        const text  = decodeBytesToText(bytes)
        // Split on \r?\n so Windows CRLF files don't embed \r into every line
        const lines = text.split(/\r?\n/)
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        this.send(peerId, { t: 'file_response', path, lines, readonly: false, req_id: reqId })
        return
      } catch {
        // file not found or unreadable — fall through to error response
      }
    }

    this.send(peerId, {
      t      : 'error',
      code   : 'file_not_found',
      message: `file not found in workspace: ${path}`,
      req_id : reqId,
    })
  }

  // ── Apply guest patch to VS Code document ─────────────────────────────────

  private async applyGuestPatch(
    path: string, lnum: number, count: number, lines: string[], fromPeer: number
  ): Promise<void> {
    const doc = vscode.workspace.textDocuments.find(d => getRelPath(d.uri) === path)
    if (!doc) return

    this.seq++
    const stamped: LiveShareMessage = {
      t: 'patch', path, seq: this.seq, peer: fromPeer, lnum, count, lines,
    }

    const startPos = new vscode.Position(lnum, 0)
    const endPos   = count === -1
      ? doc.lineAt(doc.lineCount - 1).range.end
      : new vscode.Position(lnum + count, 0)
    const replacement = lines.length > 0 ? lines.join('\n') + '\n' : ''

    this.applyingFor.add(path)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, new vscode.Range(startPos, endPos), replacement)
    await vscode.workspace.applyEdit(edit)
    this.applyingFor.delete(path)

    // Broadcast to all other guests with the stamped seq
    this.broadcast(stamped, fromPeer)
  }

  // ── Watch VS Code documents for changes ───────────────────────────────────

  private setupWatchers(): void {
    // Local edits → broadcast patch
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(ev => {
        const path = getRelPath(ev.document.uri)
        if (!path || !isShareable(ev.document)) return
        if (this.applyingFor.has(path)) return  // suppress echo-back

        for (const change of ev.contentChanges) {
          const startLine = change.range.start.line
          const endLine   = change.range.end.line
          const count     = endLine - startLine + 1
          const numNew    = change.text.split('\n').length
          const newLines: string[] = []
          for (let i = startLine; i < startLine + numNew && i < ev.document.lineCount; i++) {
            newLines.push(ev.document.lineAt(i).text)
          }
          this.seq++
          this.broadcast({ t: 'patch', path, seq: this.seq, peer: 0, lnum: startLine, count, lines: newLines })
        }
      })
    )

    // Host opened a new file
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        const path = getRelPath(doc.uri)
        if (!path || !isShareable(doc)) return
        this.broadcast({ t: 'open_file', path, lines: docToLines(doc) })
      })
    )

    // Host closed a file
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument(doc => {
        const path = getRelPath(doc.uri)
        if (!path) return
        this.broadcast({ t: 'close_file', path })
      })
    )

    // Host saved a file
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        const path = getRelPath(doc.uri)
        if (!path || !isShareable(doc)) return
        this.broadcast({ t: 'save_file', path })
      })
    )

    // Host switched active editor → focus event
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) return
        const path = getRelPath(editor.document.uri)
        if (!path || !isShareable(editor.document)) return
        this.broadcast({ t: 'focus', path, peer: 0, name: this.displayName })
      })
    )

    // Host cursor moved → cursor event (debounced 100ms)
    let cursorTimer: ReturnType<typeof setTimeout> | undefined
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(ev => {
        const path = getRelPath(ev.textEditor.document.uri)
        if (!path || !isShareable(ev.textEditor.document)) return
        if (cursorTimer) clearTimeout(cursorTimer)
        cursorTimer = setTimeout(() => {
          cursorTimer = undefined
          const sel  = ev.textEditor.selection
          const msg: LiveShareMessage = {
            t: 'cursor', path, peer: 0, name: this.displayName,
            lnum: sel.active.line, col: sel.active.character,
          }
          if (!sel.isEmpty) {
            const [start, end] = sel.anchor.isBefore(sel.active)
              ? [sel.anchor, sel.active] : [sel.active, sel.anchor]
            msg['sel_lnum']     = start.line
            msg['sel_col']      = start.character
            msg['sel_end_lnum'] = end.line
            msg['sel_end_col']  = end.character
          }
          this.broadcast(msg)
        }, 100)
      })
    )
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private encodeFor(c: PeerConn, msg: LiveShareMessage): Buffer | null {
    return this.encodeRaw(c.mode, msg)
  }

  private encodeRaw(mode: 'ws' | 'tcp', msg: LiveShareMessage): Buffer | null {
    try {
      const payload = encode(msg, this.sessionKey)
      return mode === 'ws' ? encodeWsFrame(payload) : encodeTcpFrame(payload)
    } catch {
      return null
    }
  }

  private cleanupPeer(peerId: number): void {
    const c = this.clients.get(peerId) ?? this.pending.get(peerId)
    if (c && !c.socket.destroyed) c.socket.destroy()
    this.clients.delete(peerId)
    this.pending.delete(peerId)
  }
}
