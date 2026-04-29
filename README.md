# Open Pair

[![CI](https://github.com/darkerthanblack2000/open-pair/actions/workflows/ci.yml/badge.svg)](https://github.com/darkerthanblack2000/open-pair/actions/workflows/ci.yml)

Real-time collaborative editing between VS Code and Neovim (or VS Code and VS Code) with no Microsoft account required. Uses direct TCP connections with AES-256-GCM end-to-end encryption — optionally exposed over the internet via SSH tunnels (localhost.run, serveo) or ngrok. Neovim interop via [live-share.nvim](https://github.com/azratul/live-share.nvim).

## Supported combinations

| Host | Guest | Notes |
|------|-------|-------|
| VS Code / compatible editor | VS Code / compatible editor | Full support |
| VS Code / compatible editor | Neovim ([live-share.nvim](https://github.com/azratul/live-share.nvim)) | Full support |
| Neovim ([live-share.nvim](https://github.com/azratul/live-share.nvim)) | VS Code / compatible editor | Full support |

## Demo

*Gifs used with permission from [azratul](https://github.com/azratul), maintainer of [live-share.nvim](https://github.com/azratul/live-share.nvim).*

### Neovim as Host, VS Code as Guest
![Neovim Host - VS Code Guest](https://raw.githubusercontent.com/azratul/azratul/main/nvim-vscode.gif)

### VS Code as Host, Neovim as Guest
![VS Code Host - Neovim Guest](https://raw.githubusercontent.com/azratul/azratul/main/vscode-nvim.gif)

## Features

| Feature | Status |
|---------|--------|
| Guest mode (join a Neovim or VS Code host) | ✅ |
| Host mode (serve Neovim or VS Code guests) | ✅ |
| AES-256-GCM end-to-end encryption | ✅ |
| Remote cursors & selections | ✅ |
| Follow mode | ✅ |
| Shared terminal | WIP |
| Read-only guest role | ✅ |

## Compatible editors

Works in any VS Code-compatible editor:

- [VS Code](https://code.visualstudio.com/) 1.85+
- [VSCodium](https://vscodium.com/) (open-source build without telemetry)
- [Cursor](https://www.cursor.com/)
- [Windsurf](https://windsurf.com/)
- [Google Antigravity](https://antigravity.google/)

## Requirements

- A compatible editor (see above)
- To join a Neovim session: [live-share.nvim](https://github.com/azratul/live-share.nvim) running as host
- To use a tunnel: `ssh` in PATH (for localhost.run / serveo) or `ngrok` CLI

## Usage

### Joining a session (VS Code as guest)

Works when the host is either another VS Code instance or a Neovim session running [live-share.nvim](https://github.com/azratul/live-share.nvim).

1. Get the share URL from the host (e.g. `tcp://1.2.3.4:9876#key=...` or `host.example.com:80#key=...`)
2. Open the Command Palette (`Ctrl+Shift+P`) and run **Open Pair: Join Session**
3. Paste the URL and enter your display name
4. Use **Open Pair: Open Workspace File** to browse the remote file tree
5. Use **Open Pair: Toggle Follow Mode** to follow a peer's cursor
6. Use **Open Pair: Show Peers** to see who is connected
7. Run **Open Pair: Stop Session** to disconnect

### Hosting a session (VS Code as host)

VS Code and Neovim guests can join the same session simultaneously.

1. Open a folder or workspace in VS Code
2. Run **Open Pair: Start Hosting** from the Command Palette
3. Enter your display name and port (default: 9876)
4. Choose a tunnel provider or **None** for local network only
5. The share URL is automatically copied to your clipboard
6. Share the URL — guests can join from VS Code or Neovim
7. Approve or deny each incoming connection (read-write or read-only)
8. Run **Open Pair: Stop Session** to end the session

### URL formats

| Format | Transport | When to use |
|--------|-----------|-------------|
| `tcp://host:port#key=...` | Raw TCP | ngrok `tcp://` or direct LAN |
| `host:port#key=...` | WebSocket | localhost.run, serveo, bore.pub |
| `https://host#key=...` | WebSocket | localhost.run HTTPS URLs |

## Tunnel providers

| Provider | Command | Notes |
|----------|---------|-------|
| `nokey@localhost.run` | `ssh` | Recommended — no account needed |
| `localhost.run` | `ssh` | Requires a localhost.run account |
| `serveo.net` | `ssh` | Public SSH tunnel |
| `ngrok` | `ngrok` | Requires ngrok CLI and auth token |
| None | — | Local network / VPN only |

## Limitations

- **Neovim compatibility**: requires live-share.nvim with protocol version 3+
- **Single workspace folder**: only the first workspace folder is shared when hosting
- **No offline mode**: an active network connection is required
- **Tunnel reliability**: third-party tunnels (serveo, localhost.run) may be unreliable or unavailable; for stable use prefer ngrok or a direct connection

## Troubleshooting

**Connection times out or never connects**
- Check that the port is open in any firewall on the host machine
- If using a tunnel, wait a few seconds for it to establish before sharing the URL
- Try a different tunnel provider — serveo and localhost.run can be flaky

**"No encryption key found in URL"**
- The `#key=...` fragment must be present in the URL. Make sure it wasn't stripped by your messaging app (some apps remove URL fragments)

**Files appear garbled (wrong encoding)**
- This can happen with UTF-16 LE files on Windows. Update to v0.1.8+

**Cursor of remote peer doesn't appear**
- The remote file must be open in an editor tab (not just in the file tree)

**Debug info**
- Run **Open Pair: Debug Info** from the Command Palette to dump session state, transport mode, and peer list to an output channel

## Development

```sh
git clone https://github.com/darkerthanblack2000/open-pair
cd open-pair
npm install
npm run compile   # single build
npm run watch     # rebuild on save
npm run typecheck # type-check without building
npm run lint      # ESLint
npm run format    # Prettier
```

Press **F5** in VS Code to launch the Extension Development Host.

See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## License

MIT — see [LICENSE](LICENSE)
