/**
 * documents.ts — virtual filesystem provider and patch application.
 *
 * Implements vscode.FileSystemProvider (not TextDocumentContentProvider)
 * so VS Code treats the files as editable.
 *
 * URIs: liveshare://<sid>/<workspace-relative-path>
 *
 * Remote patches  → applyPatch() → WorkspaceEdit (applying guard suppresses echo-back)
 * Local edits     → onDidChangeTextDocument → sendPatch callback → host
 * Explicit save   → writeFile() no-op (real-time sync already handles it)
 */

import * as vscode from 'vscode'
import { Session } from './session'

export const SCHEME = 'liveshare'

interface DocEntry {
  lines   : string[]
  mtime   : number    // monotonically increasing, used for FileStat
  applying: boolean
}

type PatchSender = (path: string, lnum: number, count: number, lines: string[]) => void

export class DocumentRegistry implements vscode.FileSystemProvider {

  // ── FileSystemProvider required event ─────────────────────────────────────
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile  = this._onDidChangeFile.event

  private entries   = new Map<string, DocEntry>()   // path → entry
  private uriByPath = new Map<string, vscode.Uri>() // path → uri

  private sendPatch : PatchSender | undefined
  private sid       : string | undefined
  private role      : 'rw' | 'ro' = 'ro'
  private disposables: vscode.Disposable[] = []

  // ── Setup ─────────────────────────────────────────────────────────────────

  setup(session: Session, sendPatch: PatchSender): void {
    this.sendPatch = sendPatch
    this.sid       = session.sid
    this.role      = session.role ?? 'ro'

    const sub = vscode.workspace.onDidChangeTextDocument(ev => this.onLocalChange(ev))
    this.disposables.push(sub)
  }

  // ── FileSystemProvider interface ──────────────────────────────────────────

  watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    return { dispose: () => {} }
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const path  = uriToPath(uri)
    const entry = this.entries.get(path)
    if (!entry) { throw vscode.FileSystemError.FileNotFound(uri) }
    return {
      type : vscode.FileType.File,
      ctime: 0,
      mtime: entry.mtime,
      size : Buffer.byteLength(entry.lines.join('\n'), 'utf8'),
    }
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const path  = uriToPath(uri)
    const entry = this.entries.get(path)
    if (!entry) { throw vscode.FileSystemError.FileNotFound(uri) }
    // Join with newlines; add trailing newline so the last line is complete
    return Buffer.from(entry.lines.join('\n') + '\n', 'utf8')
  }

  writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean }): void {
    // Ctrl+S no-op: real-time patch sync already handles content updates.
    // We intentionally do nothing here to avoid double-sending on save.
  }

  // Stub directory operations — not needed for our use case
  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] { return [] }
  createDirectory(_uri: vscode.Uri): void { throw vscode.FileSystemError.NoPermissions() }
  delete(_uri: vscode.Uri, _options: { readonly recursive: boolean }): void { throw vscode.FileSystemError.NoPermissions() }
  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean }): void { throw vscode.FileSystemError.NoPermissions() }

  // ── Open / close ──────────────────────────────────────────────────────────

  open(path: string, lines: string[]): vscode.Uri {
    const uri = this.makeUri(path)
    const existing = this.entries.get(path)
    if (existing) {
      existing.lines = lines
      existing.mtime = Date.now()
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }])
      return uri
    }
    this.entries.set(path, { lines, mtime: Date.now(), applying: false })
    this.uriByPath.set(path, uri)
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }])
    return uri
  }

  close(path: string): void {
    const uri = this.uriByPath.get(path)
    this.entries.delete(path)
    this.uriByPath.delete(path)
    if (uri) {
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }])
    }
  }

  closeAll(): void {
    for (const path of [...this.uriByPath.keys()]) { this.close(path) }
  }

  getUri(path: string): vscode.Uri | undefined {
    return this.uriByPath.get(path)
  }

  listPaths(): string[] {
    return [...this.entries.keys()]
  }

  // ── Apply remote patch ────────────────────────────────────────────────────

  // Returns false when the patch is out-of-range (caller should request a resync).
  async applyPatch(path: string, lnum: number, count: number, lines: string[]): Promise<boolean> {
    const entry = this.entries.get(path)
    if (!entry) { return false }

    // §7.2: out-of-range patch → signal caller to request full resync
    if (count !== -1 && lnum > entry.lines.length) { return false }

    // Update in-memory lines first
    const endIdx   = count === -1 ? entry.lines.length : lnum + count
    entry.lines    = [
      ...entry.lines.slice(0, lnum),
      ...lines,
      ...entry.lines.slice(endIdx),
    ]
    entry.mtime    = Date.now()

    const uri = this.uriByPath.get(path)
    if (!uri) { return true }

    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
    if (!doc) {
      // Not open in any editor — notify VS Code so readFile() is called on next open
      this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }])
      return true
    }

    const startPos = new vscode.Position(lnum, 0)
    const endPos   = count === -1
      ? doc.lineAt(doc.lineCount - 1).range.end
      : new vscode.Position(lnum + count, 0)

    const replacement = lines.length > 0 ? lines.join('\n') + '\n' : ''

    entry.applying = true
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, new vscode.Range(startPos, endPos), replacement)
    await vscode.workspace.applyEdit(edit)
    entry.applying = false
    return true
  }

  // ── Detect local edits → send patch to host ───────────────────────────────

  private onLocalChange(ev: vscode.TextDocumentChangeEvent): void {
    if (ev.document.uri.scheme !== SCHEME) { return }
    const path  = uriToPath(ev.document.uri)
    const entry = this.entries.get(path)
    if (!entry || entry.applying) { return }
    if (!this.sendPatch || this.role === 'ro') { return }

    const doc = ev.document

    for (const change of ev.contentChanges) {
      const startLine = change.range.start.line
      const endLine   = change.range.end.line
      // How many original lines were replaced (1 for same-line edits)
      const count     = endLine - startLine + 1
      // How many new lines result from this change
      const numNew    = change.text.split('\n').length

      // Read the full new line content from the document (already updated)
      const newLines: string[] = []
      for (let i = startLine; i < startLine + numNew && i < doc.lineCount; i++) {
        newLines.push(doc.lineAt(i).text)
      }

      this.sendPatch(path, startLine, count, newLines)

      // Keep in-memory lines in sync
      entry.lines = [
        ...entry.lines.slice(0, startLine),
        ...newLines,
        ...entry.lines.slice(startLine + count),
      ]
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private makeUri(path: string): vscode.Uri {
    const sid = this.sid ?? 'session'
    return vscode.Uri.parse(`${SCHEME}://${sid}/${path}`)
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose() }
    this.disposables = []
    this._onDidChangeFile.dispose()
    this.closeAll()
  }
}

function uriToPath(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '')
}
