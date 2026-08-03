# Migration Record

Codex Key Switcher has completed its migration from the original macOS-only Objective-C application to the current TypeScript, Next.js, and Electron architecture.

The legacy Objective-C source tree has been removed from the active repository. This document records the migration outcome for maintainers who need to understand the current module boundaries.

## Current Architecture

```text
Next.js renderer UI
  -> Electron preload API
  -> Electron IPC handlers
  -> TypeScript core services
  -> platform adapters
```

The renderer does not receive Node.js access and does not read provider secrets directly.

## Migrated Areas

| Area | Current home |
| --- | --- |
| Provider model, validation, import/export | `packages/core/src/provider` |
| Credential persistence | `apps/desktop/src/services/credential-file-store.ts` |
| Local gateway runtime | `apps/desktop/src/services/local-gateway-runtime.ts` |
| Gateway protocol adaptation | `apps/desktop/src/services/gateway-protocol-adapter.ts` |
| Codex config updates and backups | `apps/desktop/src/services/codex-file-config-adapter.ts` |
| Usage recording and migration | `apps/desktop/src/services/usage-file-repository.ts` |
| Desktop IPC and native integration | `apps/desktop/src/main/main.ts` |
| Renderer UI | `apps/web/src/components` |
| Shared contracts | `packages/shared/src` |

## Migration Status

- `v1.0.0` is the first stable release on the TypeScript, Next.js, and Electron architecture.
- Provider persistence is handled by `ProviderFileRepository`.
- Credential writes go through `CredentialFileStore` and Electron `safeStorage`.
- Provider metadata reads do not proactively decrypt API keys. Key reads are deferred until validation, direct mode writes, gateway forwarding, or export with keys.
- Legacy provider key formats are supported when a key is actually needed, including selected-key credentials and imported `apiKey` or `apiKeys` payloads.
- Provider selected model switching is exposed through typed desktop APIs.
- Provider import/export is handled through Electron file dialogs.
- Codex config update, auth update, backups, restore scripts, and gateway detection are handled by `CodexFileConfigAdapter`.
- Diagnostics read real Codex directory and local-gateway state through Electron IPC.
- Local gateway start, stop, status, authentication, provider lookup, model override, and request forwarding are handled by `LocalGatewayRuntime`.
- Responses, OpenAI-compatible Chat Completions, and Anthropic Messages protocol conversion are handled by `gateway-protocol-adapter`.
- Usage records are persisted in SQLite through `UsageFileRepository`.
- Legacy JSON usage records are migrated to SQLite once and then renamed with a `.migrated` suffix.
- Production Electron loading resolves the exported Next.js app instead of depending on `next dev`.
- Electron main and preload entrypoints are bundled with `esbuild`.
- `electron-builder` packaging is configured for macOS and Windows targets.
- Product icon assets are generated through `scripts/generate-icons.mjs`.

## v1.0.0 Compatibility Notes

- Legacy AppKit `model` fields are normalized to the current `selectedModel` field.
- Legacy multi-key records are collapsed into the selected provider credential for the current provider ID when the key is first needed.
- Startup, tray refresh, diagnostics, and provider-list rendering intentionally stay metadata-only to avoid macOS Keychain prompts on first launch.
- Direct provider mode accepts Responses-format providers only. Chat Completions and Anthropic Messages providers must continue through local gateway protocol conversion.
- Usage statistics are available for local gateway requests only. Direct provider mode bypasses the gateway and cannot record local request logs or token usage.

## Remaining Maintenance Notes

- Native credential backends can replace `CredentialFileStore` later without changing renderer code.
- Windows installer builds should be verified on a Windows runner before release.
- Production macOS builds should be signed and notarized before external distribution.
- Streaming protocol conversion should continue to be protected by fixture and regression tests.
- Release packaging should continue to verify that About, diagnostics, update checks, and installer metadata all report the same desktop version.

## Failover Behavior

- Retryable: upstream `5xx`, network failure, timeout, missing provider API key, or invalid provider Base URL.
- Not retryable: upstream `4xx`, successful responses, and streams after bytes have started flowing to the client.
- Default: disabled in route settings so production behavior remains explicit and predictable.
