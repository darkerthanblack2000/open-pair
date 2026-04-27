/**
 * extension.ts — VS Code extension entry point.
 *
 * Commands:
 *   liveshare.join           Join a Neovim (or VS Code) host as a guest
 *   liveshare.startServer    Start a VS Code host session
 *   liveshare.stop           Stop any active session
 *   liveshare.follow         Choose a peer to follow via QuickPick (guest only)
 *   liveshare.openWorkspace  File picker over the remote workspace (guest only)
 *   liveshare.showPeers      Show peers; selecting one activates follow (guest only)
 *   liveshare.debugInfo      Dump diagnostic info to an output channel
 */

import * as vscode from 'vscode'
import { Session, parseShareUrl, SessionLogger } from './session'
import { DocumentRegistry, SCHEME } from './documents'
import { CursorManager } from './cursors'
import { PeerTracker } from './peers'
import { Host, HostLogger } from './host'
import { Tunnel, PROVIDER_NAMES, ProviderName } from './tunnel'
import { LiveShareMessage, PROTOCOL_VERSION } from './protocol'

// ── Module-level state — only one session at a time ────────────────────────

let activeRole: 'guest' | 'host' | undefined

// Guest-mode state
let session: Session | undefined
let docs: DocumentRegistry | undefined
let cursors: CursorManager | undefined

// Host-mode state
let host: Host | undefined
let tunnel: Tunnel | undefined
let hostCursors: CursorManager | undefined

// Shared
let peers: PeerTracker = new PeerTracker()
let statusBar: vscode.StatusBarItem
let extCtx: vscode.ExtensionContext
let followedPeer: number | undefined
let workspaceFiles: string[] = []
let displayName: string = ''
let cursorTimer: ReturnType<typeof setTimeout> | undefined
let debugChannel: vscode.OutputChannel | undefined

// Shared terminals (guest mode)
const sharedTerminals = new Map<string, { terminal: vscode.Terminal; writeEmitter: vscode.EventEmitter<string> }>()

// ── Activate ──────────────────────────────────────────────────────────────────

export function activate(ctx: vscode.ExtensionContext): void {
  extCtx = ctx
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'liveshare.stop'
  ctx.subscriptions.push(statusBar)

  ctx.subscriptions.push(
    vscode.commands.registerCommand('liveshare.join', cmdJoin),
    vscode.commands.registerCommand('liveshare.startServer', cmdStartServer),
    vscode.commands.registerCommand('liveshare.stop', cmdStop),
    vscode.commands.registerCommand('liveshare.follow', cmdFollow),
    vscode.commands.registerCommand('liveshare.openWorkspace', cmdOpenWorkspace),
    vscode.commands.registerCommand('liveshare.showPeers', cmdShowPeers),
    vscode.commands.registerCommand('liveshare.debugInfo', cmdDebugInfo),
  )

  // Guest: emit focus when switching editors
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (activeRole !== 'guest' || !session?.connected || !editor) return
      const uri = editor.document.uri
      if (uri.scheme !== SCHEME) return
      session.send({ t: 'focus', path: uriToPath(uri), name: displayName })
    }),
  )

  // Guest: emit cursor events (debounced 100ms)
  ctx.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((ev) => {
      if (activeRole !== 'guest' || !session?.connected) return
      if (ev.textEditor.document.uri.scheme !== SCHEME) return
      const path = uriToPath(ev.textEditor.document.uri)
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = setTimeout(() => {
        cursorTimer = undefined
        sendGuestCursor(path, ev.textEditor)
      }, 100)
    }),
  )
}

export function deactivate(): void {
  teardown()
}

// ── Teardown ──────────────────────────────────────────────────────────────────

function teardown(): void {
  host?.stop()
  tunnel?.stop()
  session?.dispose()
  docs?.dispose()
  cursors?.clearAll()
  hostCursors?.clearAll()
  host = undefined
  tunnel = undefined
  session = undefined
  docs = undefined
  cursors = undefined
  hostCursors = undefined
  activeRole = undefined
  followedPeer = undefined
  workspaceFiles = []
  displayName = ''
  peers.clear()
  for (const { terminal } of sharedTerminals.values()) {
    terminal.dispose()
  }
  sharedTerminals.clear()
  refreshStatus()
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdJoin(): Promise<void> {
  if (activeRole) {
    vscode.window.showWarningMessage('Open Pair: session already active — run "Stop Session" first')
    return
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Paste the Open Pair URL',
    placeHolder: 'tcp://host:port#key=... or https://host#key=... or host:port#key=...',
  })
  if (!input) return

  const name = await vscode.window.showInputBox({
    prompt: 'Your display name',
    placeHolder: 'Your name',
  })
  if (name === undefined) return
  displayName = name || 'VS Code user'

  const parsed = parseShareUrl(input)

  docs = new DocumentRegistry()
  cursors = new CursorManager((path) => docs!.getUri(path))
  session = new Session()

  // Wire the session logger to the debug Output Channel so transport
  // events (open, message, close, error) are always visible without
  // needing to open VS Code Developer Tools.
  if (!debugChannel) {
    debugChannel = vscode.window.createOutputChannel('Open Pair — Debug Info')
    extCtx.subscriptions.push(debugChannel)
  }
  debugChannel.clear()
  const sessionLogger: SessionLogger = (msg) => {
    debugChannel!.appendLine(`[${new Date().toISOString()}] ${msg}`)
  }
  session.setLogger(sessionLogger)
  sessionLogger(
    `join started — transport=${parsed.mode} host=${parsed.host}:${parsed.port} key=${parsed.key ? 'present' : 'MISSING'}`,
  )

  const providerReg = vscode.workspace.registerFileSystemProvider(SCHEME, docs, {
    isCaseSensitive: true,
    isReadonly: false,
  })
  extCtx.subscriptions.push(providerReg)

  activeRole = 'guest'
  refreshStatus()

  // Wire patch sender once role is known (after hello)
  let patchSenderReady = false
  session.onMessage((msg) => {
    if (msg.t === 'hello' && !patchSenderReady) {
      patchSenderReady = true
      docs?.setup(session!, (path, lnum, count, lines) => {
        session?.send({ t: 'patch', path, lnum, count, lines })
      })
    }
  })

  session.onMessage((msg) => {
    void handleGuestMessage(msg)
  })
  session.connect(parsed, displayName)
}

async function cmdStartServer(): Promise<void> {
  if (activeRole) {
    vscode.window.showWarningMessage('Open Pair: session already active — run "Stop Session" first')
    return
  }

  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage('Open Pair: open a folder or workspace before hosting')
    return
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Your display name',
    placeHolder: 'Your name',
  })
  if (name === undefined) return
  displayName = name || 'VS Code user'

  const portInput = await vscode.window.showInputBox({
    prompt: 'Port to listen on',
    placeHolder: '9876',
    value: '9876',
  })
  if (portInput === undefined) return
  const port = parseInt(portInput || '9876', 10)

  const tunnelItems: vscode.QuickPickItem[] = [
    { label: 'None', description: 'Local network only (copies host:port URL)' },
    ...PROVIDER_NAMES.map((p) => ({ label: p, description: tunnelDescription(p) })),
  ]
  const tunnelPick = await vscode.window.showQuickPick(tunnelItems, {
    placeHolder: 'Select a tunnel provider (or None for local)',
    title: 'Open Pair: Tunnel',
  })
  if (tunnelPick === undefined) return
  const tunnelProvider = tunnelPick.label === 'None' ? undefined : (tunnelPick.label as ProviderName)

  peers = new PeerTracker()

  // Host-mode cursor manager: resolves relative paths to real file:// URIs
  const hostWsFolder = vscode.workspace.workspaceFolders?.[0]
  hostCursors = new CursorManager((path) => {
    if (!hostWsFolder) return undefined
    return vscode.Uri.joinPath(hostWsFolder.uri, path)
  })

  host = new Host(
    displayName,
    peers,
    (peerId) => {
      peers.upsert(peerId, {})
      refreshStatus()
    },
    (peerId, peerName) => {
      vscode.window.showInformationMessage(`Open Pair: ${peerName || `peer ${peerId}`} left`)
      hostCursors?.removePeer(peerId)
      refreshStatus()
    },
    (peerId, msg) => {
      // Render guest cursor positions in the VS Code host editor
      const path = msg['path'] as string
      const lnum = msg['lnum'] as number
      const col = msg['col'] as number
      const name = (msg['name'] as string | undefined) ?? peers.get(peerId)?.name ?? `peer ${peerId}`
      const selLnum = msg['sel_lnum'] as number | undefined
      const sel =
        selLnum !== undefined
          ? {
              lnum: selLnum,
              col: msg['sel_col'] as number,
              end_lnum: msg['sel_end_lnum'] as number,
              end_col: msg['sel_end_col'] as number,
            }
          : undefined
      hostCursors?.updateCursor(peerId, path, lnum, col, name, sel)
    },
  )

  if (!debugChannel) {
    debugChannel = vscode.window.createOutputChannel('Open Pair — Debug Info')
    extCtx.subscriptions.push(debugChannel)
  }
  debugChannel.clear()
  const hostLogger: HostLogger = (msg) => {
    debugChannel!.appendLine(`[${new Date().toISOString()}] ${msg}`)
  }
  host.setLogger(hostLogger)
  hostLogger(`host started — port=${port} sid=${host.sessionId}`)

  host.start(port)
  activeRole = 'host'
  refreshStatus()

  if (tunnelProvider) {
    tunnel = new Tunnel()
    vscode.window.showInformationMessage(`Open Pair: starting ${tunnelProvider} tunnel…`)

    tunnel.start(
      port,
      tunnelProvider,
      async (tunnelUrl) => {
        const url = tunnelUrl + host!.keyFragment
        await vscode.env.clipboard.writeText(url)
        vscode.window
          .showInformationMessage(`Open Pair: tunnel ready. URL copied to clipboard.`, 'Show URL')
          .then((choice) => {
            if (choice === 'Show URL') vscode.window.showInformationMessage(url, { modal: true })
          })
      },
      (errMsg) => {
        vscode.window.showErrorMessage(`Open Pair: tunnel error — ${errMsg}`)
      },
    )
  } else {
    const url = host.shareUrl
    await vscode.env.clipboard.writeText(url)
    vscode.window
      .showInformationMessage(`Open Pair: hosting on port ${port}. URL copied to clipboard.`, 'Show URL')
      .then((choice) => {
        if (choice === 'Show URL') vscode.window.showInformationMessage(url, { modal: true })
      })
  }
}

function tunnelDescription(provider: ProviderName): string {
  switch (provider) {
    case 'nokey@localhost.run':
      return 'SSH tunnel, no key needed (recommended)'
    case 'localhost.run':
      return 'SSH tunnel via localhost.run'
    case 'serveo.net':
      return 'SSH tunnel via serveo.net'
    case 'ngrok':
      return 'ngrok tcp (requires ngrok CLI + auth)'
    default:
      return ''
  }
}

function cmdStop(): void {
  if (!activeRole) {
    vscode.window.showInformationMessage('Open Pair: no active session')
    return
  }
  teardown()
  vscode.window.showInformationMessage('Open Pair: session stopped')
}

async function cmdFollow(): Promise<void> {
  if (activeRole !== 'guest') {
    vscode.window.showWarningMessage('Open Pair: follow mode is only available as guest')
    return
  }

  const allPeers = peers.getAll()
  if (allPeers.length === 0) {
    vscode.window.showWarningMessage('Open Pair: no peers to follow yet')
    return
  }

  type Item = vscode.QuickPickItem & { peerId?: number; disable?: true }
  const items: Item[] = allPeers.map((p) => {
    const roleLabel = p.role ? ` [${p.role}]` : ''
    const eyeMark = followedPeer === p.peerId ? ' $(eye)' : ''
    return {
      label: `$(person)${eyeMark} ${p.name}${roleLabel}`,
      description: p.peerId === 0 ? 'host' : `peer ${p.peerId}`,
      detail: p.activePath ? `Viewing: ${p.activePath}` : undefined,
      peerId: p.peerId,
    }
  })
  if (followedPeer !== undefined) {
    items.push({ label: '$(circle-slash) Disable follow mode', disable: true })
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a peer to follow',
    title: 'Open Pair: Follow',
  })
  if (!picked) return

  if (picked.disable) {
    followedPeer = undefined
    vscode.window.showInformationMessage('Open Pair: follow mode OFF')
  } else {
    followedPeer = picked.peerId
    const fpName = peers.get(picked.peerId!)?.name ?? `peer ${picked.peerId}`
    vscode.window.showInformationMessage(`Open Pair: following ${fpName}`)
  }
  refreshStatus()
}

async function cmdOpenWorkspace(): Promise<void> {
  if (activeRole !== 'guest' || !docs) {
    vscode.window.showWarningMessage('Open Pair: only available as guest')
    return
  }
  const allPaths = workspaceFiles.length > 0 ? workspaceFiles : docs.listPaths()
  if (allPaths.length === 0) {
    vscode.window.showInformationMessage('Open Pair: no files available yet')
    return
  }
  const picked = await vscode.window.showQuickPick(allPaths, { placeHolder: 'Select a file to open' })
  if (!picked) return

  const uri = docs.getUri(picked)
  if (uri) {
    await openDoc(uri)
  } else {
    session?.send({ t: 'file_request', path: picked })
  }
}

async function cmdShowPeers(): Promise<void> {
  if (!activeRole) {
    vscode.window.showWarningMessage('Open Pair: not in a session')
    return
  }

  const allPeers = peers.getAll()
  if (allPeers.length === 0) {
    vscode.window.showInformationMessage('Open Pair: no other peers connected')
    return
  }

  type Item = vscode.QuickPickItem & { peerId: number }
  const items: Item[] = allPeers.map((p) => {
    const roleLabel = p.role ? ` [${p.role}]` : ''
    const eyeMark = followedPeer === p.peerId ? ' $(eye)' : ''
    return {
      label: `$(person)${eyeMark} ${p.name}${roleLabel}`,
      description: p.peerId === 0 ? 'host' : `peer ${p.peerId}`,
      detail: p.activePath ? `Viewing: ${p.activePath}` : undefined,
      peerId: p.peerId,
    }
  })

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: activeRole === 'guest' ? 'Select a peer to follow' : `${allPeers.length} peer(s) connected`,
    title: 'Open Pair: Peers',
  })

  if (picked && activeRole === 'guest') {
    followedPeer = picked.peerId
    const fpName = peers.get(picked.peerId)?.name ?? `peer ${picked.peerId}`
    vscode.window.showInformationMessage(`Open Pair: following ${fpName}`)
    refreshStatus()
  }
}

function cmdDebugInfo(): void {
  if (!debugChannel) {
    debugChannel = vscode.window.createOutputChannel('Open Pair — Debug Info')
    extCtx.subscriptions.push(debugChannel)
  }
  debugChannel.clear()

  const pkgVersion = ((extCtx.extension.packageJSON as Record<string, unknown>).version as string) ?? '?'
  const lines: string[] = [
    '=== Open Pair — Debug Info ===',
    `Generated: ${new Date().toISOString()}`,
    '',
    '[Extension]',
    `  Version:           ${pkgVersion}`,
    `  Protocol version:  ${PROTOCOL_VERSION}`,
    `  VS Code:           ${vscode.version}`,
    `  Node.js:           ${process.version}`,
    `  Platform:          ${process.platform} (${process.arch})`,
    '',
  ]

  if (!activeRole) {
    lines.push('[Session]', '  No active session.', '')
  } else if (activeRole === 'guest') {
    const fpName =
      followedPeer !== undefined
        ? (peers.get(followedPeer)?.name ?? (followedPeer === 0 ? 'host' : `peer ${followedPeer}`))
        : 'none'
    lines.push(
      '[Session]',
      `  Role:              guest`,
      `  Connected:         ${session?.connected ?? false}`,
      `  Transport:         ${session?.transportMode ?? '?'}`,
      `  Peer ID:           ${session?.peerId ?? '?'}`,
      `  Session ID:        ${session?.sid ?? '?'}`,
      `  Guest role:        ${session?.role ?? '?'}`,
      `  Following:         ${fpName}`,
      '',
    )
  } else {
    lines.push(
      '[Session]',
      `  Role:              host`,
      `  Session ID:        ${host?.sessionId ?? '?'}`,
      `  Port:              ${host?.port ?? '?'}`,
      `  Share URL:         ${host?.shareUrl ?? '?'}`,
      `  Guests connected:  ${host?.guestCount ?? 0}`,
      '',
    )
  }

  const allPeers = peers.getAll()
  if (allPeers.length > 0) {
    lines.push('[Peers]')
    for (const p of allPeers) {
      const roleStr = p.role ? ` [${p.role}]` : ''
      const pathStr = p.activePath ? `  →  ${p.activePath}` : ''
      const idLabel = p.peerId === 0 ? '(host)' : `(peer ${p.peerId})`
      lines.push(`  ${p.name}${roleStr} ${idLabel}${pathStr}`)
    }
    lines.push('')
  }

  debugChannel.append(lines.join('\n'))
  debugChannel.show(true)
}

// ── Guest message handler ─────────────────────────────────────────────────────

async function handleGuestMessage(msg: LiveShareMessage): Promise<void> {
  if (!docs || !cursors || !session) return

  switch (msg.t) {
    case 'hello': {
      const roleBadge = session.role === 'ro' ? ' [read-only]' : ''
      vscode.window.showInformationMessage(`Open Pair: connected${roleBadge} (host: ${msg['host_name'] ?? '?'})`)
      peers.upsert(0, { name: (msg['host_name'] as string | undefined) ?? 'host', role: 'rw' })
      refreshStatus()
      break
    }

    case 'workspace_info': {
      workspaceFiles = (msg['files'] as string[] | undefined) ?? []
      const rootName = (msg['root_name'] as string | undefined) ?? '?'
      vscode.window.showInformationMessage(
        `Open Pair: workspace '${rootName}' (${workspaceFiles.length} files). Use "Open Workspace File" to browse.`,
      )
      break
    }

    case 'open_files_snapshot': {
      const files = (msg['files'] as Array<{ path: string; lines: string[] }> | undefined) ?? []
      let first = true
      for (const f of files) {
        const uri = docs.open(f.path, f.lines)
        if (first) {
          first = false
          await openDoc(uri)
        }
      }
      break
    }

    case 'peers_snapshot': {
      const peerList =
        (msg['peers'] as Array<{ peer_id: number; name: string; active_path?: string }> | undefined) ?? []
      for (const p of peerList) {
        peers.upsert(p.peer_id, { name: p.name, activePath: p.active_path })
      }
      refreshStatus()
      break
    }

    case 'open_file': {
      const path = msg['path'] as string
      const lines = (msg['lines'] as string[] | undefined) ?? []
      const uri = docs.open(path, lines)
      if (followedPeer === 0) {
        await openDoc(uri)
      } else {
        const hint = followedPeer === undefined ? '  (follow mode is off)' : ''
        vscode.window.showInformationMessage(`Open Pair: host opened ${path}${hint}`)
      }
      break
    }

    case 'close_file': {
      const path = msg['path'] as string
      cursors.clearForPath(path)
      docs.close(path)
      vscode.window.showInformationMessage(`Open Pair: host closed ${path}`)
      break
    }

    case 'file_response': {
      const path = msg['path'] as string
      const lines = (msg['lines'] as string[] | undefined) ?? []
      await openDoc(docs.open(path, lines))
      break
    }

    case 'patch': {
      const path = msg['path'] as string
      const lnum = msg['lnum'] as number
      const count = msg['count'] as number
      const lines = (msg['lines'] as string[] | undefined) ?? []
      // §7.2: out-of-range → request full resync from host
      const ok = await docs.applyPatch(path, lnum, count, lines)
      if (!ok) {
        session.send({ t: 'file_request', path })
      }
      break
    }

    case 'save_file':
      vscode.window.showInformationMessage(`Open Pair: host saved ${msg['path']}`)
      break

    case 'focus': {
      const path = msg['path'] as string
      const peer = msg['peer'] as number
      const name = msg['name'] as string | undefined
      peers.upsert(peer, { activePath: path, ...(name ? { name } : {}) })
      if (followedPeer !== undefined && peer === followedPeer) {
        const uri = docs.getUri(path)
        if (uri) {
          await openDoc(uri)
        } else {
          session.send({ t: 'file_request', path })
        }
      }
      break
    }

    case 'cursor': {
      const path = msg['path'] as string
      const peer = msg['peer'] as number
      const lnum = msg['lnum'] as number
      const col = msg['col'] as number
      const name = msg['name'] as string | undefined
      const selLnum = msg['sel_lnum'] as number | undefined
      const sel =
        selLnum !== undefined
          ? {
              lnum: selLnum,
              col: msg['sel_col'] as number,
              end_lnum: msg['sel_end_lnum'] as number,
              end_col: msg['sel_end_col'] as number,
            }
          : undefined
      cursors.updateCursor(peer, path, lnum, col, name, sel)
      break
    }

    case 'bye': {
      const peer = msg['peer'] as number
      const label = (msg['name'] as string | undefined) ?? (peer === 0 ? 'host' : `peer ${peer}`)
      cursors.removePeer(peer)
      peers.remove(peer)
      if (followedPeer === peer) {
        followedPeer = undefined
        vscode.window.showInformationMessage(`Open Pair: ${label} left — follow mode disabled`)
      } else {
        vscode.window.showInformationMessage(`Open Pair: ${label} left`)
      }
      if (peer === 0) {
        teardown()
        return
      }
      refreshStatus()
      break
    }

    case 'terminal_open': {
      const termId = msg['term_id'] as string
      const name = (msg['name'] as string | undefined) ?? `Open Pair Terminal`
      if (sharedTerminals.has(termId)) break

      const writeEmitter = new vscode.EventEmitter<string>()
      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {},
        close: () => {
          sharedTerminals.delete(termId)
          writeEmitter.dispose()
        },
        handleInput: (data: string) => {
          session?.send({ t: 'terminal_input', term_id: termId, data })
        },
      }
      const terminal = vscode.window.createTerminal({ name, pty })
      sharedTerminals.set(termId, { terminal, writeEmitter })
      terminal.show()
      break
    }

    case 'terminal_data': {
      const termId = msg['term_id'] as string
      const data = msg['data'] as string
      sharedTerminals.get(termId)?.writeEmitter.fire(data)
      break
    }

    case 'terminal_close': {
      const termId = msg['term_id'] as string
      const entry = sharedTerminals.get(termId)
      if (entry) {
        entry.terminal.dispose()
        sharedTerminals.delete(termId)
      }
      break
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function openDoc(uri: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri)
  await setDocumentLanguage(doc)
  await vscode.window.showTextDocument(doc, { preview: false })
}

async function setDocumentLanguage(doc: vscode.TextDocument): Promise<void> {
  // VS Code should auto-detect language from the URI path for FileSystemProvider.
  // If it falls back to 'plaintext', try to detect from the file extension.
  if (doc.languageId !== 'plaintext') return
  const ext = doc.uri.path.split('.').pop()?.toLowerCase()
  const langId = EXT_TO_LANG[ext ?? '']
  if (langId) {
    try {
      await vscode.languages.setTextDocumentLanguage(doc, langId)
    } catch {
      /* ignore */
    }
  }
}

// Common extension → VS Code language ID mapping
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'jsonc',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'mdx',
  tex: 'latex',
  r: 'r',
  sql: 'sql',
  dockerfile: 'dockerfile',
  tf: 'terraform',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  ml: 'ocaml',
  fs: 'fsharp',
  dart: 'dart',
  elm: 'elm',
}

function refreshStatus(): void {
  if (!activeRole) {
    statusBar.hide()
    return
  }
  statusBar.command = 'liveshare.stop'
  statusBar.show()

  if (activeRole === 'guest') {
    if (!session?.connected) {
      statusBar.text = '$(loading~spin) Open Pair: connecting…'
      statusBar.tooltip = 'Connecting…'
      return
    }
    const hostName = peers.get(0)?.name ?? 'host'
    const peerCount = peers.count
    let suffix: string
    if (followedPeer !== undefined) {
      const fpName = peers.get(followedPeer)?.name ?? (followedPeer === 0 ? 'host' : `peer ${followedPeer}`)
      suffix = `following ${fpName}`
    } else {
      suffix = `${peerCount} peer${peerCount !== 1 ? 's' : ''}`
    }
    statusBar.text = `$(rss) ${hostName} | ${suffix}`
    statusBar.tooltip = 'Open Pair — guest (click to stop)'
  } else {
    const gc = host?.guestCount ?? 0
    statusBar.text = `$(broadcast) Hosting | ${gc} guest${gc !== 1 ? 's' : ''}`
    statusBar.tooltip = 'Open Pair — host (click to stop)'
  }
}

function uriToPath(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '')
}

function sendGuestCursor(path: string, editor: vscode.TextEditor): void {
  const sel = editor.selection
  const msg: LiveShareMessage = {
    t: 'cursor',
    path,
    lnum: sel.active.line,
    col: sel.active.character,
    name: displayName,
  }
  if (!sel.isEmpty) {
    const [start, end] = sel.anchor.isBefore(sel.active) ? [sel.anchor, sel.active] : [sel.active, sel.anchor]
    msg['sel_lnum'] = start.line
    msg['sel_col'] = start.character
    msg['sel_end_lnum'] = end.line
    msg['sel_end_col'] = end.character
  }
  session?.send(msg)
}
