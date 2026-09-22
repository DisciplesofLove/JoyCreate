# Security Policy

## Supported Versions

We will provide security fixes for the latest version of JoyCreate and encourage JoyCreate users through auto-updates to use the latest version of the app.

## Reporting a Vulnerability

Please file security vulnerabilities by using [report a vulnerability](https://github.com/DisciplesofLove/JoyCreate/security/advisories/new). Please do not file security vulnerabilities as a regular issue as the information could be used to exploit JoyCreate users.

## Development Security Guidelines

Contributors must follow these rules (enforced in review and CI):

- **Never commit secrets.** `.env` is gitignored — copy `.env.example` and fill in your own keys. Runtime data directories (`userData/`, `n8n-config` runtime files, `celestia-blobs/`) are gitignored and must stay that way. CI runs a gitleaks secret scan on every PR.
- **Electron IPC boundary.** New IPC channels require a handler, `ipc_host.ts` registration, a `src/preload.ts` allowlist entry, and an `IpcClient` method. Never use the `remote` module. Validate and lock by `appId` when mutating shared resources.
- **Handlers throw on failure** — never return fake-success payloads. A feature that isn't implemented must fail loudly, not silently succeed.
- **Dependencies.** CI runs `npm audit` (high+ severity on production deps fails the build) and CodeQL analysis on every PR.
- **OAuth client IDs are public identifiers**, but client secrets, API keys, and encryption keys are not — keep those in `.env` or the OS keychain (`safeStorage`).
