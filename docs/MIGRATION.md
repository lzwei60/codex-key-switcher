# Migration Plan

## Analysis

The Objective-C app is macOS-only because UI, status bar, launch-at-login, signing, and credential behavior depend on Cocoa, AppKit, ServiceManagement, and Security frameworks.

## Root Cause

Core logic is coupled to platform code:

- Provider persistence and API key handling are called directly from AppKit views.
- Route settings are stored through scattered `NSUserDefaults` writes.
- `LocalGateway.m` combines server, routing, protocol conversion, streaming, logging, and usage recording.
- Menu and page reload side effects are coupled through `ProviderStore.onChange`.

## Best Practice

Move business logic to TypeScript core packages and keep platform APIs in Electron main-process adapters.

```text
Next UI -> preload API -> Electron IPC -> core services -> platform adapters
```

The renderer never receives Node.js access and never reads secrets directly.

## File Mapping

| Objective-C file | New home |
| --- | --- |
| `ProviderStore.m` | `packages/core/src/provider` |
| `LocalAPIKeyStore.m` | `apps/desktop/src/services/credential-store.ts` |
| `LocalGateway.m` | `packages/core/src/gateway` |
| `CodexConfigWriter.m` | `packages/core/src/codex` plus platform path adapter |
| `CodexModelCatalogWriter.m` | `packages/core/src/codex` |
| `UsageStore.m` | `packages/core/src/usage` |
| `ProviderListView.m` | `apps/web/src/components/CodexKeySwitcherApp.tsx` |
| `ProviderFormView.m` | `apps/web/src/components/CodexKeySwitcherApp.tsx` |
| `SettingsView.m` | `apps/web/src/components/CodexKeySwitcherApp.tsx` |
| `StatsView.m` | `apps/web/src/components/CodexKeySwitcherApp.tsx` |
| `AppDelegate.m` | `apps/desktop/src/main/main.ts` |

## Migration Order

1. Provider model, validation, import/export.
2. Credential storage on macOS and Windows.
3. Codex config writer and restore backup.
4. Local gateway non-stream request forwarding.
5. Responses to Chat Completions and Anthropic conversion.
6. SSE streaming conversion.
7. Usage statistics and diagnostics.
8. Packaging, signing, and auto-start.

## Hidden Risks

- Streaming conversion needs fixture tests before refactor.
- Windows secrets must use encryption, not plain JSON.
- Production desktop builds must be signed and notarized before external macOS distribution.
- Windows installer builds should be verified on a Windows runner before release.

## Progress

- Completed: Provider persistence moved from in-memory storage to `ProviderFileRepository`.
- Completed: API Key storage moved behind `CredentialFileStore`; new writes require Electron `safeStorage` OS encryption.
- Completed: Provider selected model switching through core service and Electron IPC.
- Completed: Provider import/export through Electron file dialogs; export can omit or include API keys.
- Pending: Native credential backends can replace `CredentialFileStore` later without changing renderer code.
- Completed: Core `CodexConfigWriter.m` behavior migrated into `CodexFileConfigAdapter`: config update, auth update, managed backups, restore script, restore backup, and gateway detection.
- Completed: Diagnostics now reads the real Codex directory and local-gateway config state through Electron IPC.
- Completed: `CodexModelCatalogWriter.m` migrated into `CodexModelCatalogWriter` TypeScript service.
- Completed: `LocalGateway.m` first phase migrated into `LocalGatewayRuntime`: real HTTP start/stop/status, local authentication, active provider lookup, active model override, and native Responses non-stream forwarding.
- Completed: Non-stream protocol adapters migrated into `gateway-protocol-adapter`: Responses request conversion to Chat Completions and Anthropic Messages, plus upstream response conversion back to Responses JSON.
- Completed: SSE streaming conversion migrated for native Responses pass-through and adapted Chat Completions / Anthropic Messages text and function-call deltas.
- Completed: Usage recording migrated through `UsageService` and `UsageFileRepository`; gateway requests now persist provider, model, status, duration, source, and parsed token usage when upstream responses expose it.
- Completed: Failover migrated in `LocalGatewayRuntime`; when enabled in route settings, retryable upstream failures try the next configured provider and response headers expose whether fallback was used.
- Completed: Production Electron loading no longer depends on `next dev`; main process resolves the exported Next `index.html` from development build output or packaged resources.
- Completed: Desktop startup settings migrated through Electron `app.getLoginItemSettings` / `app.setLoginItemSettings` and exposed through typed preload IPC.
- Completed: Desktop production build now bundles Electron main/preload with `esbuild`, so runtime no longer depends on workspace TypeScript packages.
- Completed: `electron-builder` packaging is configured for mac universal, mac x64, mac arm64, and Windows x64; mac arm64 and mac universal DMG builds have been verified locally.
- Completed: Product icon assets are generated through `scripts/generate-icons.mjs`; mac packages now use `icon.icns` and Windows packages are configured to use `icon.ico`.

## Failover Behavior

- Retryable: upstream `5xx`, network failure, timeout, missing provider API key, or invalid provider Base URL.
- Not retryable: upstream `4xx`, successful responses, and streams after bytes have started flowing to the client.
- Default: disabled in route settings so production behavior remains explicit and predictable.
