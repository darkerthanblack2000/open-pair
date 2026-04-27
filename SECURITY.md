# Security Policy

## Scope

Open Pair involves network connections, end-to-end encryption, remote editing, and an optional shared terminal. Security issues in these areas are taken seriously.

In scope:
- Encryption weaknesses or key leakage (AES-256-GCM, key in URL fragment)
- Authentication or approval-flow bypass (host accept/reject)
- Arbitrary code execution via crafted protocol messages
- Tunnel provider interactions that expose session data
- Shared terminal escape or privilege escalation

Out of scope:
- Vulnerabilities in tunnel providers (serveo.net, localhost.run, ngrok) themselves
- VS Code platform vulnerabilities
- Issues requiring physical access to the host machine

## Supported versions

Only the latest published version on the VS Code Marketplace is supported.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
[https://github.com/darkerthanblack2000/open-pair/security/advisories/new](https://github.com/darkerthanblack2000/open-pair/security/advisories/new)

Include:
- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- Any suggested mitigations

You will receive a response within 7 days. If the issue is confirmed, a fix will be released as soon as possible and you will be credited in the changelog unless you prefer to remain anonymous.
