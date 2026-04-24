/**
 * tunnel.ts — SSH reverse-tunnel integration for VS Code host mode.
 *
 * Mirrors the Neovim plugin's tunnel.lua / provider.lua approach:
 *   - Spawns an SSH (or ngrok) process
 *   - Scans stdout+stderr for the public URL via a regex pattern
 *   - Calls onUrl() once the URL is found; calls onError() on failure
 *
 * Supported providers (same as live-share.nvim):
 *   nokey@localhost.run  — recommended, no SSH key needed
 *   localhost.run        — same service, uses your SSH key
 *   serveo.net           — alternative SSH tunnel
 *   ngrok                — ngrok tcp (requires ngrok CLI installed + auth)
 *
 * Note: HTTP-proxy providers (localhost.run, serveo) expose an https:// URL.
 * Neovim parses that as WebSocket mode and sends the HTTP upgrade immediately,
 * so transport detection on the VS Code host side works without any issues.
 */

import * as cp from 'node:child_process'

export type ProviderName =
  | 'nokey@localhost.run'
  | 'localhost.run'
  | 'serveo.net'
  | 'ngrok'

interface ProviderSpec {
  /** Returns the argv array for the tunnel command. */
  buildArgv: (port: number) => string[]
  /** Regex to extract the public URL from the command output. */
  pattern: RegExp
}

const PROVIDERS: Record<ProviderName, ProviderSpec> = {
  'nokey@localhost.run': {
    buildArgv: (port) => [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-N',
      '-R', `80:localhost:${port}`,
      'nokey@localhost.run',
    ],
    pattern: /https:\/\/[\w.-]+\.lhr\.life/,
  },
  'localhost.run': {
    buildArgv: (port) => [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-N',
      '-R', `80:localhost:${port}`,
      'localhost.run',
    ],
    pattern: /https:\/\/[\w.-]+\.lhr\.life/,
  },
  'serveo.net': {
    buildArgv: (port) => [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-N',
      '-R', `80:localhost:${port}`,
      'serveo.net',
    ],
    // serveo prints e.g. "Forwarding HTTP traffic from https://abcdef.serveo.net"
    pattern: /https:\/\/[\w.-]+\.serveo\.net/,
  },
  'ngrok': {
    buildArgv: (port) => [
      'ngrok', 'tcp', String(port), '--log', 'stdout',
    ],
    // ngrok prints e.g. msg="started tunnel" ... url=tcp://0.tcp.ngrok.io:12345
    pattern: /tcp:\/\/[\w.-]+\.ngrok(?:free)?\.app:\d+|tcp:\/\/\d+\.tcp\.ngrok\.io:\d+/,
  },
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as ProviderName[]

/** Timeout (ms) waiting for the tunnel URL to appear in output. */
const URL_TIMEOUT_MS = 30_000

export class Tunnel {
  private proc   : cp.ChildProcess | undefined
  private timer  : ReturnType<typeof setTimeout> | undefined
  private stopped = false

  /**
   * Start the tunnel for the given provider and local port.
   *
   * @param port     Local TCP port the VS Code host is listening on.
   * @param provider One of the PROVIDER_NAMES.
   * @param onUrl    Called once with the public URL (without key fragment).
   * @param onError  Called if the tunnel fails to start or times out.
   */
  start(
    port: number,
    provider: ProviderName,
    onUrl: (url: string) => void,
    onError: (msg: string) => void,
  ): void {
    const spec = PROVIDERS[provider]
    if (!spec) {
      onError(`Unknown tunnel provider: ${provider}`)
      return
    }

    const argv     = spec.buildArgv(port)
    const needsSsh = argv[0] === 'ssh'

    if (needsSsh && process.platform === 'win32') {
      // Verify OpenSSH is available before spawning; surface a helpful message if not.
      cp.exec('ssh -V', (err) => {
        if (err) {
          onError(
            'ssh not found. Install OpenSSH: Settings → Apps → Optional Features → OpenSSH Client, or install Git for Windows.'
          )
          return
        }
        this._spawn(argv, spec.pattern, onUrl, onError)
      })
      return
    }

    this._spawn(argv, spec.pattern, onUrl, onError)
  }

  private _spawn(
    argv   : string[],
    pattern: RegExp,
    onUrl  : (url: string) => void,
    onError: (msg: string) => void,
  ): void {
    this.proc = cp.spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let buf   = ''
    let found = false
    this.stopped = false

    const scan = (chunk: Buffer | string) => {
      if (found) return
      buf += chunk.toString('utf8')
      const m = buf.match(pattern)
      if (m) {
        found = true
        this.clearTimer()
        onUrl(m[0])
      }
    }

    this.proc.stdout?.on('data', scan)
    this.proc.stderr?.on('data', scan)

    this.proc.on('error', (err) => {
      if (this.stopped) return
      if (!found) {
        found = true
        this.clearTimer()
      }
      onError(`Tunnel process error: ${err.message}`)
    })

    this.proc.on('close', (code) => {
      if (this.stopped) return
      if (!found) {
        found = true
        this.clearTimer()
        onError(`Tunnel process exited (code ${code ?? '?'}) without providing a URL`)
      } else {
        // SSH died after the URL was already announced — the tunnel is gone.
        onError(`Tunnel disconnected unexpectedly (code ${code ?? '?'}) — guests can no longer connect`)
      }
    })

    // Fail fast if the URL never appears
    this.timer = setTimeout(() => {
      if (!found) {
        found = true
        onError(`Tunnel URL not found after ${URL_TIMEOUT_MS / 1000}s — is ${argv[0]} installed and reachable?`)
        this.stop()
      }
    }, URL_TIMEOUT_MS)
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
    this.proc = undefined
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
