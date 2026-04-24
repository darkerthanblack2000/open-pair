# open-pair — Live Share for VS Code + Neovim

Real-time collaborative editing between VS Code and Neovim, compatible with [azratul/live-share.nvim](https://github.com/azratul/live-share.nvim). No Microsoft account, no cloud relay — direct TCP connections with AES-256-GCM encryption.

## Features

| Feature | Status |
|---------|--------|
| Guest join (WebSocket / raw TCP) | ✅ |
| Host mode (VS Code → Neovim or VS Code guests) | ✅ |
| AES-256-GCM end-to-end encryption | ✅ |
| Virtual documents (`liveshare://` scheme) | ✅ |
| Remote cursors & selections | ✅ |
| Follow mode | ✅ |
| Automatic reconnection (3 attempts, exponential backoff) | ✅ |
| Shared terminal | WIP |
| Read-only guest role | ✅ |

## Requirements

- VS Code 1.85+
- To join a Neovim session: a running [live-share.nvim](https://github.com/azratul/live-share.nvim) host
- To host for Neovim guests: guests must use live-share.nvim ≥ the version that supports VS Code hosts

## Usage

### Joining a session (guest)

1. The host (Neovim or VS Code) shares a URL, e.g. `tcp://1.2.3.4:9876#key=...` or `host.example.com:80#key=...`
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`) and run **Live Share: Join Session**
3. Paste the URL and enter your display name
4. Use **Live Share: Open Workspace File** to browse the remote file tree
5. Use **Live Share: Toggle Follow Mode** to follow the host's cursor
6. Use **Live Share: Show Peers** to see who's connected
7. Run **Live Share: Stop Session** to disconnect

### Hosting a session

1. Open a folder or workspace in VS Code
2. Run **Live Share: Start Hosting** from the Command Palette
3. Enter your display name and port (default: 9876)
4. The share URL is copied to your clipboard automatically
5. Share the URL with your collaborators — they can join from VS Code or Neovim
6. Approve or deny each incoming connection (R/W or Read Only)
7. Run **Live Share: Stop Session** to end the session

### URL formats

| Format | Transport | Example |
|--------|-----------|---------|
| `tcp://host:port#key=...` | Raw TCP | `tcp://192.168.1.5:9876#key=abc123` |
| `host:port#key=...` | WebSocket | `serveo.net:80#key=abc123` |
| `https://host#key=...` | WebSocket | `https://abc.serveo.net#key=abc123` |

## Development

```sh
git clone https://github.com/darkerthanblack2000/open-pair
cd open-pair/vscode
npm install
npm run compile   # single build
npm run watch     # rebuild on save
npm run typecheck # type-check without building
```

Press **F5** in VS Code to launch the Extension Development Host.

To package: `npm run package` (outputs a `.vsix` file).

## License

MIT — see [LICENSE](LICENSE)
