# Changelog

All notable changes to Open Pair are documented here.

## [Unreleased]

### Fixed
- **Joining through a tunnel never reached the host.** `https://` and `wss://` share URLs were dialled as plaintext `ws://` on port 80, so the connection hung or hit a redirect and the host was never asked to approve — every HTTP tunnel provider (serveo.net, localhost.run) serves these tunnels over TLS on 443. Such URLs now connect with `wss://` on 443, with certificate validation. Only sessions using an `https://`/`wss://` URL are affected; `tcp://`, bare `host:port`, and localhost are unchanged.
- **Only the first join per window worked.** The `liveshare://` filesystem provider was registered on every join but never unregistered, so the second attempt failed with "a filesystem provider for the scheme 'liveshare' is already registered" until VS Code was restarted. It is now released on session teardown.
- **A join that never reached the host left the session stuck.** Connecting to an unreachable address hung with no deadline, and a URL rejected outright (missing `#key=`, `punch+`) left the session marked active — either way every later join was refused with "session already active". Joins now abort after 15 s with a clear error and reset cleanly.

## [0.2.2] — 2026-07-27

### Fixed
- **"Open Pair: Join Session" missing from the Command Palette.** Command IDs were declared under the `liveshare.*` namespace, which belongs to Microsoft Live Share (`ms-vsliveshare.vsliveshare`). `liveshare.join` and `liveshare.follow` were exact ID collisions, so with both extensions installed VS Code resolved those palette entries to Live Share's titles and Open Pair's entries disappeared. All commands are now under `openPair.*`.
- Packaged `.vsix` no longer ships internal development notes (`TODO.md`, `CLAUDE.md`, `GEMINI.md`, `*.txt`) or lint/format config.

### Changed
- **Breaking:** command IDs renamed `liveshare.*` → `openPair.*`. Custom keybindings, tasks, or scripts referencing the old IDs must be updated.

## [0.1.9] — 2026-04-27

### Added
- Prettier + ESLint setup with CI-enforced formatting
- GitHub Actions CI: typecheck, lint, format check, package, vsix artifact upload
- `CONTRIBUTING.md`, `SECURITY.md`, issue templates, PR template

### Changed
- All user-visible strings renamed from "Live Share" to "Open Pair"

## [0.1.8] — 2026-04-25

### Fixed
- Files with UTF-16 LE encoding (with and without BOM) now display correctly when the host is on Windows and the guest is Neovim on Linux

## [0.1.7] — 2026-04-24

### Added
- Host mode: VS Code can now act as host for Neovim and VS Code guests

### Fixed
- Windows compatibility: tunnel commands, path resolution, IPv6 listener
- Host mode connection handling and listener lifecycle

## [0.1.6] — 2026-04-24

### Security
- Dependency audit: replaced vulnerable transitive dependencies

## [0.1.5] — 2026-04-24

### Added
- `Open Pair: Show Peers` command — QuickPick list of connected peers, select to follow
- `Open Pair: Debug Info` command — dumps session state, transport mode, peer list, and protocol version to an output channel

### Fixed
- Protocol compatibility with live-share.nvim: updated `workspace_info`, `open_files_snapshot`, and `peers_snapshot` message handling
- Protocol version negotiation and session handshake alignment with live-share.nvim
- Extension icon and publisher metadata
- Host mode approval flow and peer registry
- Protocol version field and AES-GCM decryption edge cases

## [0.1.0] — 2026-03-31

### Added
- Initial release
- Guest mode: join a Neovim or VS Code host via WebSocket or raw TCP
- AES-256-GCM end-to-end encryption (key in URL fragment)
- Virtual documents (`liveshare://` scheme) with patch-based sync
- Remote cursors and selections (6-color palette)
- Follow mode: track a peer's active file
- Shared terminal (read/write, PTY output streaming)
- Read-only guest role support
