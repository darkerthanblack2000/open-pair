/**
 * cursors.ts — remote cursor and selection decorations.
 *
 * One TextEditorDecorationType per peer, cycling through a 6-color palette.
 * Renders:
 *   - A colored vertical bar at the cursor column (vscode.window.activeTextEditor)
 *   - An optional background highlight for visual selections (sel_* fields)
 *   - An "eol" label showing the peer's name
 *
 * All positions are 0-based (as sent by Neovim).
 */

import * as vscode from 'vscode'

// Palette matches the DiagnosticVirtualText* cycle used in Neovim presence.lua
const PALETTE = [
  { cursor: '#61afef', selection: '#61afef33' }, // blue
  { cursor: '#e5c07b', selection: '#e5c07b33' }, // yellow
  { cursor: '#98c379', selection: '#98c37933' }, // green
  { cursor: '#e06c75', selection: '#e06c7533' }, // red
  { cursor: '#c678dd', selection: '#c678dd33' }, // purple
  { cursor: '#56b6c2', selection: '#56b6c233' }, // cyan
]

interface PeerState {
  name: string
  decType: vscode.TextEditorDecorationType
  selDecType: vscode.TextEditorDecorationType
  path: string | undefined
  lnum: number
  col: number
}

export class CursorManager {
  private peers = new Map<number, PeerState>()

  /** resolver maps a relative path to the URI of the document to decorate. */
  constructor(private readonly resolver: (path: string) => vscode.Uri | undefined) {}

  updateCursor(
    peerId: number,
    path: string,
    lnum: number,
    col: number,
    name: string | undefined,
    sel?: { lnum: number; col: number; end_lnum: number; end_col: number },
  ): void {
    let state = this.peers.get(peerId)
    if (!state) {
      const color = PALETTE[peerId % PALETTE.length]
      state = {
        name: name ?? `peer ${peerId}`,
        decType: vscode.window.createTextEditorDecorationType({
          borderWidth: '0 0 0 2px',
          borderStyle: 'solid',
          borderColor: color.cursor,
          after: {
            contentText: '',
            color: color.cursor,
            fontWeight: 'bold',
          },
        }),
        selDecType: vscode.window.createTextEditorDecorationType({
          backgroundColor: color.selection,
        }),
        path: undefined,
        lnum: 0,
        col: 0,
      }
      this.peers.set(peerId, state)
    }

    if (name) {
      state.name = name
    }
    state.path = path
    state.lnum = lnum
    state.col = col

    this.render(peerId, state, path, lnum, col, sel)
  }

  removePeer(peerId: number): void {
    const state = this.peers.get(peerId)
    if (!state) {
      return
    }
    state.decType.dispose()
    state.selDecType.dispose()
    this.peers.delete(peerId)
  }

  clearForPath(path: string): void {
    for (const [id, state] of this.peers) {
      if (state.path === path) {
        this.removePeer(id)
      }
    }
  }

  clearAll(): void {
    for (const id of [...this.peers.keys()]) {
      this.removePeer(id)
    }
  }

  private render(
    _peerId: number,
    state: PeerState,
    path: string,
    lnum: number,
    col: number,
    sel?: { lnum: number; col: number; end_lnum: number; end_col: number },
  ): void {
    const uri = this.resolver(path)
    if (!uri) {
      return
    }

    // Find all editors showing this document
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri.toString())
    if (editors.length === 0) {
      return
    }

    const safeLine = (l: number, doc: vscode.TextDocument) => Math.min(Math.max(l, 0), doc.lineCount - 1)

    for (const editor of editors) {
      const doc = editor.document
      const line = safeLine(lnum, doc)
      const lineText = doc.lineAt(line).text
      const safeCol = Math.min(col, lineText.length)

      // Cursor decoration (vertical bar + eol label)
      const cursorPos = new vscode.Position(line, safeCol)
      const cursorRange = new vscode.Range(cursorPos, cursorPos)
      editor.setDecorations(state.decType, [
        {
          range: cursorRange,
          renderOptions: {
            after: {
              contentText: ` ${state.name} `,
            },
          },
        },
      ])

      // Selection decoration
      if (sel) {
        const selStart = new vscode.Position(safeLine(sel.lnum, doc), sel.col)
        // end_col from Neovim is inclusive; VS Code end is exclusive
        const selEnd = new vscode.Position(safeLine(sel.end_lnum, doc), sel.end_col + 1)
        editor.setDecorations(state.selDecType, [new vscode.Range(selStart, selEnd)])
      } else {
        editor.setDecorations(state.selDecType, [])
      }
    }
  }
}
