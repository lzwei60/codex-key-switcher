# Codex Key Switcher

[English](README.md) | [简体中文](README.zh-CN.md)

Codex Key Switcher is a cross-platform desktop application for managing Codex-compatible AI provider configurations, local gateway routing, direct provider configuration, model selection, diagnostics, and usage statistics.

The project is built with TypeScript, Next.js, Electron, and shared workspace packages. It keeps product logic testable, platform integrations isolated, and the renderer free from direct access to local secrets.

Current stable version: `v1.0.4`.

## Features

- Manage multiple AI provider profiles from one desktop application.
- Switch active provider and model configuration for Codex workflows.
- Run a local gateway for provider routing and protocol adaptation.
- Use direct provider mode to write Responses-format providers directly into the Codex config.
- Support Responses, OpenAI-compatible Chat Completions, and Anthropic Messages-style providers.
- Store provider credentials through the desktop process instead of exposing secrets to the renderer.
- Avoid decrypting local API keys during startup, tray refresh, and provider-list rendering.
- Inspect gateway diagnostics and local usage statistics.
- Configure usage recording, retention days, and maximum retained records.
- Share core business logic across desktop and UI layers.

## Project Structure

```text
apps/web       Next.js renderer UI
apps/desktop   Electron main process, preload bridge, and local services
packages/core  Provider, gateway, Codex config, and usage business logic
packages/shared Shared types and IPC contracts
docs           User guides, governance, and project documentation
scripts        Repository maintenance scripts
```

## Requirements

- Node.js 22 or newer
- pnpm 9.15.0 or newer

The package manager version is pinned in `package.json`.

## Development

Install dependencies:

```bash
pnpm install
```

Start the desktop development environment:

```bash
pnpm dev
```

Run quality checks before opening a pull request:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Build

Build all workspace packages:

```bash
pnpm build
```

Package the desktop application:

```bash
pnpm --filter @codex-key-switcher/desktop dist
```

Platform-specific package commands are available in `apps/desktop/package.json`.

## Updates and Releases

The desktop app supports manual update checks through GitHub Releases. Because current installers are unsigned, the app opens the matching installer download page instead of downloading and running installers automatically.

`v1.0.4` is the current stable release. The GitHub Release tag should be `v1.0.4`; the application and installer version should be `1.0.4`.

Required release assets:

- `Codex-Key-Switcher-1.0.4-arm64.dmg` for macOS Apple Silicon.
- `Codex-Key-Switcher-1.0.4-x64.dmg` for macOS Intel.
- `Codex-Key-Switcher-Setup-1.0.4-x64.exe` for Windows x64.
- `Codex-Key-Switcher-1.0.4-x86_64.AppImage` and `Codex-Key-Switcher-1.0.4-amd64.deb` for Linux x64.

See [Release Process](docs/RELEASE.md) for the full release checklist.

## Data and Privacy

- API keys are stored only in the local application data directory and encrypted through Electron `safeStorage`.
- The renderer process never receives plaintext API keys directly.
- First launch, provider-list rendering, and tray refresh do not proactively decrypt API keys.
- The app reads a local key only when checking models, validating a provider switch, enabling direct provider mode, forwarding gateway requests, or exporting providers with keys included.
- Usage stats record only local-gateway metadata such as provider, model, token counts, status, and duration. Request bodies, response bodies, and API keys are not recorded.

## Security

Codex Key Switcher handles provider API keys and local gateway traffic. Do not commit real API keys, provider exports containing credentials, local application data, diagnostic logs with authorization headers, or environment files.

Security-sensitive areas include:

- Credential storage and import/export.
- Local gateway authorization.
- Upstream request forwarding and header handling.
- Usage logs and diagnostic output.
- Release signing, notarization, and installer packaging.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Documentation

- [Chinese User Guide](docs/USER_GUIDE.zh-CN.md)
- [English User Guide](docs/USER_GUIDE.en-US.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Open Source Governance](docs/OPEN_SOURCE_GOVERNANCE.md)

## Contributing

All changes to the protected branch must go through a pull request. Pull requests should pass CI, describe user-facing impact, and call out changes to product rules, security behavior, release behavior, or user data handling.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution workflow.

## License

This project is licensed under the [MIT License](LICENSE).
