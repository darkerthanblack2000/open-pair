# Contributing to Open Pair

## Setup

```sh
git clone https://github.com/darkerthanblack2000/open-pair
cd open-pair
npm install
```

Press **F5** in VS Code to launch the Extension Development Host.

## Development workflow

```sh
npm run watch      # rebuild on save
npm run typecheck  # type-check without building
npm run lint       # ESLint
npm run format     # Prettier (writes in place)
```

All four must pass before opening a PR. CI runs them automatically.

## Testing

There is no automated test suite yet. To test manually:

1. Launch the Extension Development Host (F5)
2. Open a folder in the host window
3. Run **Open Pair: Start Hosting** and copy the URL
4. Open a second VS Code window (or use Neovim with live-share.nvim) and join with the URL
5. Verify edits, cursors, and follow mode work in both directions

For Windows-specific behaviour, test file encoding (UTF-16 LE files are common on Windows).

## Pull requests

- One logical change per PR
- Run `npm run typecheck && npm run lint && npm run format:check` locally before pushing
- Describe **what** changed and **why** in the PR description
- Keep commits focused; squash fixups before merging

## Project structure

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point, command registration, guest message handler |
| `src/session.ts` | Guest session state machine, auto-reconnect |
| `src/transport.ts` | WebSocket (masked) and raw TCP (4-byte LE prefix) transports |
| `src/protocol.ts` | JSON encode/decode + AES-256-GCM wrapper |
| `src/documents.ts` | Virtual filesystem (`liveshare://`), patch application |
| `src/cursors.ts` | Remote cursor and selection decorations |
| `src/peers.ts` | Peer tracker, QuickPick |
| `src/host.ts` | VS Code host: TCP server, approval flow, broadcast |
| `src/tunnel.ts` | SSH/ngrok tunnel management |
