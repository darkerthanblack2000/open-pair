/**
 * peers.ts — tracks connected peers for display in the peers list.
 *
 * Used by both host mode (tracks guests) and guest mode (tracks host + other guests).
 */

import * as vscode from 'vscode'

export interface PeerInfo {
  peerId    : number
  name      : string
  role      ?: 'rw' | 'ro'
  activePath?: string
}

export class PeerTracker {
  private map = new Map<number, PeerInfo>()

  upsert(peerId: number, updates: Partial<Omit<PeerInfo, 'peerId'>>): void {
    const existing = this.map.get(peerId) ?? { peerId, name: `peer ${peerId}` }
    this.map.set(peerId, { ...existing, ...updates })
  }

  remove(peerId: number): void {
    this.map.delete(peerId)
  }

  get(peerId: number): PeerInfo | undefined {
    return this.map.get(peerId)
  }

  getAll(): PeerInfo[] {
    return [...this.map.values()].sort((a, b) => a.peerId - b.peerId)
  }

  clear(): void {
    this.map.clear()
  }

  async showPeers(): Promise<void> {
    const peers = this.getAll()
    if (peers.length === 0) {
      vscode.window.showInformationMessage('Live Share: no other peers connected')
      return
    }
    const items = peers.map(p => {
      const roleLabel = p.role ? ` [${p.role}]` : ''
      return {
        label      : `$(person) ${p.name}${roleLabel}`,
        description: p.peerId === 0 ? 'host' : `peer ${p.peerId}`,
        detail     : p.activePath ? `Viewing: ${p.activePath}` : undefined,
      }
    })
    await vscode.window.showQuickPick(items, {
      placeHolder: `${peers.length} peer(s) connected`,
      canPickMany: false,
    })
  }
}
