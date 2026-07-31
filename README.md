# Codex Key Switcher

TypeScript + Next.js + Electron rewrite for the original macOS AppKit project.

## Goals

- Keep the existing provider, model, gateway, settings, stats, diagnostics, and tray workflows.
- Share business logic across macOS and Windows.
- Keep platform-specific APIs behind adapters instead of leaking them into UI code.

## Structure

```text
apps/web       Next.js UI
apps/desktop   Electron main process, tray, preload, native integrations
packages/core  Provider, gateway, Codex config, usage business logic
packages/shared Shared types and IPC contracts
legacy         Original Objective-C source kept as migration reference
```

## Development

```bash
pnpm install
pnpm dev
```

Quality checks before merging:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## User Guides

- [中文使用说明](docs/USER_GUIDE.zh-CN.md)
- [English User Guide](docs/USER_GUIDE.en-US.md)

## Open Source Governance

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Repository governance and branch protection checklist](docs/OPEN_SOURCE_GOVERNANCE.md)

## Migration Status

This repository currently contains the cross-platform shell and typed service boundaries. The next step is to port behavior module-by-module from `legacy/macos-appkit/Sources`.

## License

[MIT](LICENSE)
