/**
 * extension.ts — VS Code extension entry point.
 *
 * Commands:
 *   liveshare.join           Join a Neovim (or VS Code) host as a guest
 *   liveshare.startServer    Start a VS Code host session
 *   liveshare.stop           Stop any active session
 *   liveshare.follow         Toggle follow mode (guest only)
 *   liveshare.openWorkspace  File picker over the remote workspace (guest only)
 *   liveshare.showPeers      Show connected peers
 */

import * as vscode from 'vscode'
import { Session, parseShareUrl } from './session'
import { DocumentRegistry, SCHEME } from './documents'
import { CursorManager } from './cursors'
import { PeerTracker } from './peers'
import { Host } from './host'
import { Tunnel, PROVIDER_NAMES, ProviderName } from './tunnel'
import { LiveShareMessage } from './protocol'

// ── Module-level state — only one session at a time ────────────────────────

let activeRole  : 'guest' | 'host' | undefined

// Guest-mode state
let session     : Session          | undefined
let docs        : DocumentRegistry | undefined
let cursors     : CursorManager    | undefined

// Host-mode state
let host        : Host             | undefined
let tunnel      : Tunnel           | undefined

// Shared
let peers       : PeerTracker      = new PeerTracker()
let statusBar   : vscode.StatusBarItem
let extCtx      : vscode.ExtensionContext
let followedPeer: number | undefined
let workspaceFiles: string[] = []
let displayName : string = ''
let cursorTimer : ReturnType<typeof setTimeout> | undefined

// Shared terminals (guest mode)
const sharedTerminals = new Map<string, { terminal: vscode.Terminal; writeEmitter: vscode.EventEmitter<string> }>()

// ── Activate ──────────────────────────────────────────────────────────────────

export function activate(ctx: vscode.ExtensionContext): void {
  extCtx    = ctx
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusBar.command = 'liveshare.stop'
  ctx.subscriptions.push(statusBar)

  ctx.subscriptions.push(
    vscode.commands.registerCommand('liveshare.join',          cmdJoin),
    vscode.commands.registerCommand('liveshare.startServer',   cmdStartServer),
    vscode.commands.registerCommand('liveshare.stop',          cmdStop),
    vscode.commands.registerCommand('liveshare.follow',        cmdFollow),
    vscode.commands.registerCommand('liveshare.openWorkspace', cmdOpenWorkspace),
    vscode.commands.registerCommand('liveshare.showPeers',     cmdShowPeers),
  )

  // Guest: emit focus when switching editors
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (activeRole !== 'guest' || !session?.connected || !editor) return
      const uri = editor.document.uri
      if (uri.scheme !== SCHEME) return
      session.send({ t: 'focus', path: uriToPath(uri), name: displayName })
    })
  )

  // Guest: emit cursor events (debounced 100ms)
  ctx.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(ev => {
      if (activeRole !== 'guest' || !session?.connected) return
      if (ev.textEditor.document.uri.scheme !== SCHEME) return
      const path = uriToPath(ev.textEditor.document.uri)
      if (cursorTimer) clearTimeout(cursorTimer)
      cursorTimer = setTimeout(() => {
        cursorTimer = undefined
        sendGuestCursor(path, ev.textEditor)
      }, 100)
    })
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
  host         = undefined
  tunnel       = undefined
  session      = undefined
  docs         = undefined
  cursors      = undefined
  activeRole   = undefined
  followedPeer = undefined
  workspaceFiles = []
  displayName  = ''
  peers.clear()
  for (const { terminal } of sharedTerminals.values()) {
    terminal.dispose()
  }
  sharedTerminals.clear()
  setStatus(null)
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdJoin(): Promise<void> {
  if (activeRole) {
    vscode.window.showWarningMessage('Live Share: session already active — run "Stop Session" first')
    return
  }

  const input = await vscode.window.showInputBox({
    prompt      : 'Paste the Live Share URL',
    placeHolder : 'tcp://host:port#key=... or https://host#key=... or host:port#key=...',
  })
  if (!input) return

  const name = await vscode.window.showInputBox({
    prompt      : 'Your display name',
    placeHolder : 'Your name',
  })
  if (name === undefined) return
  displayName = name || 'VS Code user'

  const parsed = parseShareUrl(input)

  docs    = new DocumentRegistry()
  cursors = new CursorManager(docs)
  session = new Session()

  const providerReg = vscode.workspace.registerFileSystemProvider(SCHEME, docs, {
    isCaseSensitive: true,
    isReadonly     : false,
  })
  extCtx.subscriptions.push(providerReg)

  activeRole = 'guest'
  setStatus('connecting')

  // Wire patch sender once role is known (after hello)
  let patchSenderReady = false
  session.onMessage(msg => {
    if (msg.t === 'hello' && !patchSenderReady) {
      patchSenderReady = true
      docs?.setup(session!, (path, lnum, count, lines) => {
        session?.send({ t: 'patch', path, lnum, count, lines })
      })
    }
  })

  session.onMessage(msg => { void handleGuestMessage(msg) })
  session.connect(parsed, displayName)
}

async function cmdStartServer(): Promise<void> {
  if (activeRole) {
    vscode.window.showWarningMessage('Live Share: session already active — run "Stop Session" first')
    return
  }

  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage('Live Share: open a folder or workspace before hosting')
    return
  }

  const name = await vscode.window.showInputBox({
    prompt      : 'Your display name',
    placeHolder : 'Your name',
  })
  if (name === undefined) return
  displayName = name || 'VS Code user'

  const portInput = await vscode.window.showInputBox({
    prompt      : 'Port to listen on',
    placeHolder : '9876',
    value       : '9876',
  })
  if (portInput === undefined) return
  const port = parseInt(portInput || '9876', 10)

  const tunnelItems: vscode.QuickPickItem[] = [
    { label: 'None', description: 'Local network only (copies host:port URL)' },
    ...PROVIDER_NAMES.map(p => ({ label: p, description: tunnelDescription(p) })),
  ]
  const tunnelPick = await vscode.window.showQuickPick(tunnelItems, {
    placeHolder: 'Select a tunnel provider (or None for local)',
    title      : 'Live Share: Tunnel',
  })
  if (tunnelPick === undefined) return
  const tunnelProvider = tunnelPick.label === 'None' ? undefined : tunnelPick.label as ProviderName

  peers = new PeerTracker()
  host  = new Host(
    displayName,
    peers,
    (peerId) => { peers.upsert(peerId, {}) },
    (peerId, peerName) => {
      vscode.window.showInformationMessage(`Live Share: ${peerName || `peer ${peerId}`} left`)
    },
  )

  host.start(port)
  activeRole = 'host'
  setStatus('host')

  if (tunnelProvider) {
    tunnel = new Tunnel()
    vscode.window.showInformationMessage(`Live Share: starting ${tunnelProvider} tunnel…`)

    tunnel.start(
      port,
      tunnelProvider,
      async (tunnelUrl) => {
        const url = tunnelUrl + host!.keyFragment
        await vscode.env.clipboard.writeText(url)
        vscode.window.showInformationMessage(
          `Live Share: tunnel ready. URL copied to clipboard.`,
          'Show URL',
        ).then(choice => {
          if (choice === 'Show URL') vscode.window.showInformationMessage(url, { modal: true })
        })
      },
      (errMsg) => {
        vscode.window.showErrorMessage(`Live Share: tunnel error — ${errMsg}`)
      },
    )
  } else {
    const url = host.shareUrl
    await vscode.env.clipboard.writeText(url)
    vscode.window.showInformationMessage(
      `Live Share: hosting on port ${port}. URL copied to clipboard.`,
      'Show URL',
    ).then(choice => {
      if (choice === 'Show URL') vscode.window.showInformationMessage(url, { modal: true })
    })
  }
}

function tunnelDescription(provider: ProviderName): string {
  switch (provider) {
    case 'nokey@localhost.run': return 'SSH tunnel, no key needed (recommended)'
    case 'localhost.run'      : return 'SSH tunnel via localhost.run'
    case 'serveo.net'         : return 'SSH tunnel via serveo.net'
    case 'ngrok'              : return 'ngrok tcp (requires ngrok CLI + auth)'
    default                   : return ''
  }
}

function cmdStop(): void {
  if (!activeRole) {
    vscode.window.showInformationMessage('Live Share: no active session')
    return
  }
  teardown()
  vscode.window.showInformationMessage('Live Share: session stopped')
}

function cmdFollow(): void {
  if (activeRole !== 'guest') {
    vscode.window.showWarningMessage('Live Share: follow mode is only available as guest')
    return
  }
  if (followedPeer !== undefined) {
    followedPeer = undefined
    vscode.window.showInformationMessage('Live Share: follow mode OFF')
  } else {
    followedPeer = 0
    vscode.window.showInformationMessage('Live Share: follow mode ON — following host')
  }
}

async function cmdOpenWorkspace(): Promise<void> {
  if (activeRole !== 'guest' || !docs) {
    vscode.window.showWarningMessage('Live Share: only available as guest')
    return
  }
  const allPaths = workspaceFiles.length > 0 ? workspaceFiles : docs.listPaths()
  if (allPaths.length === 0) {
    vscode.window.showInformationMessage('Live Share: no files available yet')
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
    vscode.window.showWarningMessage('Live Share: not in a session')
    return
  }
  await peers.showPeers()
}

// ── Guest message handler ─────────────────────────────────────────────────────

async function handleGuestMessage(msg: LiveShareMessage): Promise<void> {
  if (!docs || !cursors || !session) return

  switch (msg.t) {

    case 'hello': {
      setStatus('connected')
      const roleBadge = session.role === 'ro' ? ' [read-only]' : ''
      vscode.window.showInformationMessage(
        `Live Share: connected${roleBadge} (host: ${msg['host_name'] ?? '?'})`
      )
      // Register host as peer 0
      peers.upsert(0, { name: (msg['host_name'] as string | undefined) ?? 'host', role: 'rw' })
      break
    }

    case 'workspace_info': {
      workspaceFiles = (msg['files'] as string[] | undefined) ?? []
      const rootName = (msg['root_name'] as string | undefined) ?? '?'
      vscode.window.showInformationMessage(
        `Live Share: workspace '${rootName}' (${workspaceFiles.length} files). Use "Open Workspace File" to browse.`
      )
      break
    }

    case 'open_files_snapshot': {
      const files = (msg['files'] as Array<{ path: string; lines: string[] }> | undefined) ?? []
      let first = true
      for (const f of files) {
        const uri = docs.open(f.path, f.lines)
        if (first) { first = false; await openDoc(uri) }
      }
      break
    }

    case 'peers_snapshot': {
      const peerList = (msg['peers'] as Array<{ peer_id: number; name: string; active_path?: string }> | undefined) ?? []
      for (const p of peerList) {
        peers.upsert(p.peer_id, { name: p.name, activePath: p.active_path })
      }
      break
    }

    case 'open_file': {
      const path  = msg['path'] as string
      const lines = (msg['lines'] as string[] | undefined) ?? []
      const uri   = docs.open(path, lines)
      if (followedPeer === 0) {
        await openDoc(uri)
      } else {
        vscode.window.showInformationMessage(
          `Live Share: host opened ${path}  (follow mode is off)`
        )
      }
      break
    }

    case 'close_file': {
      const path = msg['path'] as string
      cursors.clearForPath(path)
      docs.close(path)
      vscode.window.showInformationMessage(`Live Share: host closed ${path}`)
      break
    }

    case 'file_response': {
      const path  = msg['path'] as string
      const lines = (msg['lines'] as string[] | undefined) ?? []
      await openDoc(docs.open(path, lines))
      break
    }

    case 'patch': {
      const path  = msg['path']  as string
      const lnum  = msg['lnum']  as number
      const count = msg['count'] as number
      const lines = (msg['lines'] as string[] | undefined) ?? []
      await docs.applyPatch(path, lnum, count, lines)
      break
    }

    case 'save_file':
      vscode.window.showInformationMessage(`Live Share: host saved ${msg['path']}`)
      break

    case 'focus': {
      const path = msg['path'] as string
      const peer = msg['peer'] as number
      const name = msg['name'] as string | undefined
      peers.upsert(peer, { activePath: path, ...(name ? { name } : {}) })
      if (followedPeer !== undefined && peer === followedPeer) {
        const uri = docs.getUri(path)
        if (uri) { await openDoc(uri) }
        else     { session.send({ t: 'file_request', path }) }
      }
      break
    }

    case 'cursor': {
      const path  = msg['path'] as string
      const peer  = msg['peer'] as number
      const lnum  = msg['lnum'] as number
      const col   = msg['col']  as number
      const name  = msg['name'] as string | undefined
      const selLnum = msg['sel_lnum'] as number | undefined
      const sel   = selLnum !== undefined ? {
        lnum    : selLnum,
        col     : msg['sel_col']      as number,
        end_lnum: msg['sel_end_lnum'] as number,
        end_col : msg['sel_end_col']  as number,
      } : undefined
      cursors.updateCursor(peer, path, lnum, col, name, sel)
      break
    }

    case 'bye': {
      const peer  = msg['peer'] as number
      const label = (msg['name'] as string | undefined) ?? (peer === 0 ? 'host' : `peer ${peer}`)
      cursors.removePeer(peer)
      peers.remove(peer)
      vscode.window.showInformationMessage(`Live Share: ${label} left`)
      if (peer === 0) teardown()
      break
    }

    case 'terminal_open': {
      const termId = msg['term_id'] as string
      const name   = (msg['name'] as string | undefined) ?? `Live Share Terminal`
      if (sharedTerminals.has(termId)) break

      const writeEmitter = new vscode.EventEmitter<string>()
      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open      : () => {},
        close     : () => {
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
      const data   = msg['data'] as string
      sharedTerminals.get(termId)?.writeEmitter.fire(data)
      break
    }

    case 'terminal_close': {
      const termId = msg['term_id'] as string
      const entry  = sharedTerminals.get(termId)
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
  const ext      = doc.uri.path.split('.').pop()?.toLowerCase()
  const langId   = EXT_TO_LANG[ext ?? '']
  if (langId) {
    try { await vscode.languages.setTextDocumentLanguage(doc, langId) } catch { /* ignore */ }
  }
}

// Common extension → VS Code language ID mapping
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', jsx: 'javascriptreact',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  lua: 'lua', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  ps1: 'powershell', yaml: 'yaml', yml: 'yaml', json: 'json', jsonc: 'jsonc',
  toml: 'toml', xml: 'xml', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', sass: 'sass', less: 'less', vue: 'vue', svelte: 'svelte',
  md: 'markdown', mdx: 'mdx', tex: 'latex', r: 'r', sql: 'sql',
  dockerfile: 'dockerfile', tf: 'terraform', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', ml: 'ocaml', fs: 'fsharp', dart: 'dart', elm: 'elm',
}

function setStatus(state: 'connecting' | 'connected' | 'host' | null): void {
  if (state === null) { statusBar.hide(); return }
  const labels = {
    connecting: { text: '$(loading~spin) Live Share: connecting…', tip: 'Connecting…' },
    connected : { text: '$(broadcast) Live Share [guest]',         tip: 'Click to stop session' },
    host      : { text: '$(broadcast) Live Share [host]',          tip: 'Click to stop hosting' },
  }
  const l = labels[state]
  statusBar.text    = l.text
  statusBar.tooltip = l.tip
  statusBar.command = 'liveshare.stop'
  statusBar.show()
}

function uriToPath(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '')
}

function sendGuestCursor(path: string, editor: vscode.TextEditor): void {
  const sel = editor.selection
  const msg: LiveShareMessage = {
    t: 'cursor', path, lnum: sel.active.line, col: sel.active.character, name: displayName,
  }
  if (!sel.isEmpty) {
    const [start, end] = sel.anchor.isBefore(sel.active)
      ? [sel.anchor, sel.active] : [sel.active, sel.anchor]
    msg['sel_lnum']     = start.line
    msg['sel_col']      = start.character
    msg['sel_end_lnum'] = end.line
    msg['sel_end_col']  = end.character
  }
  session?.send(msg)
}
