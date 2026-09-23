# Release Process

Codex Key Switcher distributes unsigned desktop installers through GitHub Releases. The application does not perform silent auto-updates. Users check for updates in the app, open the matching release asset, download the installer, and install it manually.

## Supported Artifacts

Every public release must upload these installer assets:

| Platform | Build Command | Required Asset Pattern |
| --- | --- | --- |
| macOS Apple Silicon | `pnpm --filter @codex-key-switcher/desktop dist:mac:arm64` | `Codex-Key-Switcher-<version>-arm64.dmg` |
| macOS Intel | `pnpm --filter @codex-key-switcher/desktop dist:mac:x64` | `Codex-Key-Switcher-<version>-x64.dmg` |
| Windows x64 | `pnpm --filter @codex-key-switcher/desktop dist:win` | `Codex-Key-Switcher-Setup-<version>-x64.exe` |
| Linux x64 | `pnpm --filter @codex-key-switcher/desktop dist:linux` | `Codex-Key-Switcher-<version>-x86_64.AppImage` and `Codex-Key-Switcher-<version>-amd64.deb` |

The in-app updater selects the installer by file name. Do not rename release assets unless the matching logic in `apps/desktop/src/main/main.ts` is updated in the same release.

The packaged application names are also fixed for upgrade compatibility: `Codex Key Switcher.app` on macOS, `codex-key-switcher.exe` inside the Windows installer, and `codex-key-switcher` inside Linux packages. On macOS, drag the new app over the existing `Codex Key Switcher.app` in `/Applications`; do not keep both a renamed old app and the new app.

## Versioning

1. Update `version` in `apps/desktop/package.json`.
2. Use a matching Git tag, for example `v1.0.5`.
3. The GitHub Release marked as latest must use that same tag.

The update check compares `app.getVersion()` with the latest GitHub Release tag or release name after removing a leading `v`.

## Release Checklist

1. Confirm the protected branch contains the release change through a reviewed pull request.
2. Run quality checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

3. Build all supported installers:

```bash
pnpm --filter @codex-key-switcher/desktop dist:mac:arm64
pnpm --filter @codex-key-switcher/desktop dist:mac:x64
pnpm --filter @codex-key-switcher/desktop dist:win
pnpm --filter @codex-key-switcher/desktop dist:linux
```

4. Create a GitHub Release with a tag matching the desktop version, for example `v1.0.5`.
5. Upload the four platform asset groups from the `release/` directory.
6. Mark the GitHub Release as the latest release.
7. Install the previous desktop version and verify Settings -> Updates:
   - The latest version is detected.
   - The current platform is shown correctly.
   - The matched installer name is correct.
   - Download Installer opens the expected GitHub Release asset.
   - Release Notes opens the GitHub Release page.

## Unsigned Installer Notes

The current project intentionally ships unsigned installers. This means:

- macOS may show a Gatekeeper warning on first launch.
- Windows may show a SmartScreen warning on first launch.
- The app should not download and execute installers automatically.
- Release notes should tell users that the installer is unsigned and must be downloaded from this repository's GitHub Releases page.

Signing and notarization should be added before treating this as a production-grade public distribution flow.

## v1.0.5 Release Notes

### Release Scope

`v1.0.5` is a local gateway reliability release. It adds configurable provider failover, circuit protection, fallback model mapping, attempt-level usage records, and safer runtime configuration updates.

### New Features

- Configure local-gateway failover attempts, total timeout, failure threshold, cooldown, and half-open concurrency.
- Configure provider priority and fallback model mappings for failover requests.
- Record every failover attempt with request ID, attempt number, final-attempt state, error category, provider, model, status, and duration.

### Fixes and Improvements

- Restart the local gateway when its listen address or port changes instead of leaving the old listener active.
- Clear stale circuit-breaker state when failover is disabled.
- Continue the failover chain when a backup provider credential cannot be read, while recording the credential error.
- Release half-open circuit permits on every attempt outcome, including exceptions.
- Preserve existing provider, credential, usage, and connection settings during upgrade.

### Upgrade Notes

- Existing providers and route settings are preserved. New failover settings use conservative defaults when absent.
- Chat Completions and Anthropic models still require local gateway mode; direct provider mode requires Responses.
- Installers are still unsigned and not notarized. Download them only from this repository's GitHub Releases page.

### Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.5-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.5-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.5-x64.exe`
- Linux x64: `Codex-Key-Switcher-1.0.5-x86_64.AppImage` and `Codex-Key-Switcher-1.0.5-amd64.deb`

## v1.0.4 Release Notes

### Release Scope

`v1.0.4` is a model capability, protocol adaptation, and reliability release for `v1.0.3`. It adds per-model protocol selection within one provider, hardens Codex model Catalog generation, fixes incomplete streaming and gateway timeout behavior, and completes the provider configuration and bilingual UI improvements.

### New Features

- Configure an independent API format per model: Responses, Chat Completions, or Anthropic Messages.
- Configure per-model reasoning and image-input capabilities, with explicit inherit-from-provider options.
- Fetch upstream model lists, check individual models, and warn before saving models that have not been checked.
- Route each request to the selected model within the current provider based on the request `model` value.
- Generate and complete a fuller Codex model Catalog so missing fields are less likely to break `model/list` or `thread/start` compatibility.
- Add regression coverage for protocol conversion, model Catalog validation, timeouts, interrupted streams, and cross-model routing.
- Add bilingual labels and runtime messages across the tray menu, diagnostics, providers, settings, and usage views.

### Fixes

- Fixed native Responses streams that start directly with text deltas or close early. The gateway now emits `response.failed` for abnormal termination instead of fabricating `response.completed`.
- Fixed system instructions, tool-call history, and full message history conversion for Chat Completions and Anthropic Messages.
- Fixed requests that only contain `previous_response_id` or `conversation` across protocols; they now fail with a clear 400 before contacting the upstream instead of silently losing history.
- Fixed forwarding of image or file history to models that cannot accept it; unsupported attachments are rejected explicitly.
- Fixed missing phase-specific timeouts for upstream headers, ordinary requests, idle streams, and request-body reads. Timeouts are recorded as failures with the appropriate status.
- Fixed false client-disconnect detection after a request body was read normally.
- Fixed protocol entry points, model mapping, and request-header handling for DeepSeek and similar OpenAI-compatible upstreams.
- Fixed duplicate model aliases, loss of model capability options, and stale “checked” state after a model was edited.

### Improvements

- Reworked the model editor into grouped basic and advanced sections, with a single-column layout on narrow screens.
- Localized runtime errors in the providers, diagnostics, updates, and usage views instead of exposing internal English messages directly.
- Improved model Catalog template matching to reuse cached templates by upstream model name and use a complete fallback template when no match exists.
- Clarified default-model switch notifications so they do not imply that an existing session will hot-switch its explicitly selected model.
- Improved streaming backpressure, client-disconnect cleanup, and failure recording to reduce leaked long-lived connections and false successes.

### Upgrade Notes

- Existing providers, credentials, usage data, and connection settings are preserved. Optional model capability fields in older configurations continue to use provider defaults.
- Reload Codex's model list after changing a provider, model, or connection mode. The switcher's default model does not override a model explicitly selected by an existing session.
- Chat Completions and Anthropic models require local gateway mode. Direct provider mode requires all models to resolve to Responses.
- Cross-protocol continuation requires the full visible conversation history; the adapter does not attempt to reconstruct history from a Responses-only response ID.
- Installers are still unsigned and not notarized. Download them only from this repository's GitHub Releases page.

### Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.4-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.4-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.4-x64.exe`
- Linux x64: `Codex-Key-Switcher-1.0.4-x86_64.AppImage` and `Codex-Key-Switcher-1.0.4-amd64.deb`

### Known Limitations

- Cross-protocol adapters currently guarantee text and function-tool history. Image or file history on Chat Completions or Anthropic paths is rejected explicitly.
- Windows and Linux installers can be cross-built on the macOS host, but target-system installation, launch, and upgrade smoke tests are still required before public distribution.

## v1.0.3 Release Notes

### Release Scope

`v1.0.3` is a hardening and packaging release for the `v1.0.2` stable line. It improves Codex model Catalog synchronization, local gateway safety, file persistence reliability, route rollback behavior, Linux packaging, and release metadata consistency.

### Fixes and Improvements

- Added automatic Codex model Catalog generation so provider models are written through `model_catalog_json` and stay aligned with the active connection mode.
- Added stable local-gateway model slugs with collision handling and reverse mapping back to upstream model names.
- Hardened local gateway authorization, request-size handling, client disconnect handling, streaming response cleanup, and listen-address normalization.
- Switched local JSON/config writes to atomic writes with stricter POSIX permissions for Codex config, auth, backups, and app data files.
- Added rollback behavior when provider saves or route setting changes fail after partial persistence.
- Added Electron single-instance protection so repeated launches focus the existing window instead of starting competing gateway/config writers.
- Added Linux x64 AppImage/deb packaging support and update-asset matching.
- Expanded tests for model Catalog generation, model slug mapping/collisions, gateway protocol adaptation, config backup/restore behavior, and provider persistence rollback.

### Upgrade Notes

- This release keeps existing provider, credential, usage, and route settings.
- After switching provider, model, or connection mode, fully quit and restart Codex so it reloads the generated model Catalog and connection configuration.
- Local gateway mode now defaults to loopback-only listening unless LAN listening is explicitly enabled.
- Installers are still unsigned and not notarized. Download them only from this repository's GitHub Releases page.

### Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.3-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.3-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.3-x64.exe`
- Linux x64: `Codex-Key-Switcher-1.0.3-x86_64.AppImage` and `Codex-Key-Switcher-1.0.3-amd64.deb`

### Notes

- macOS may show a Gatekeeper warning on first launch. Windows may show a SmartScreen warning on first launch.
- Windows and Linux cross-platform installers should be smoke-tested on their target operating systems before public distribution.

## v1.0.2 Release Notes

### Release Scope

`v1.0.2` is a patch release for the `v1.0.1` stable line. It fixes local gateway forwarding for third-party Responses-compatible gateways that reject OpenAI hosted tool types such as `web_search`.

### Fixes and Improvements

- Fixed upstream errors like `tool type 'web_search' is not supported by this gateway phase` when Codex requests are routed through third-party Responses gateways such as `https://api.xiaomimimo.com/v1`.
- The local gateway now filters unsupported hosted Responses tools for non-OpenAI upstreams while preserving regular function tools.
- Unsupported hosted `tool_choice` values are removed when the corresponding hosted tool is filtered, preventing follow-up request validation failures.
- OpenAI's official Responses API keeps receiving hosted tools unchanged.
- Added unit tests that cover third-party gateway filtering and OpenAI passthrough behavior.

### Upgrade Notes

- This release keeps existing provider, credential, usage, and route settings.
- The fix applies when Codex traffic goes through local gateway mode. Direct provider mode bypasses the local gateway and cannot rewrite unsupported tool payloads.
- The model Catalog and Codex configuration are loaded at Codex startup. After switching provider, model, or connection mode, fully quit and restart Codex.

### Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.2-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.2-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.2-x64.exe`
- Linux x64: `Codex-Key-Switcher-1.0.2-x64.AppImage` and/or `.deb`

### Notes

- Installers are still unsigned and not notarized. Download them only from this repository's GitHub Releases page.
- macOS may show a Gatekeeper warning on first launch. Windows may show a SmartScreen warning on first launch.

## v1.0.1 Release Notes

### Release Scope

`v1.0.1` is a patch release for the `v1.0.0` stable line. It fixes local gateway auto-start persistence, connection-state drift in direct provider mode, unnecessary route restarts, and release/version metadata consistency.

### Fixes and Improvements

- Fixed app startup auto-start for local gateway and direct provider mode. Quitting the app now stops the runtime and restores Codex config without overwriting the saved enabled route setting.
- Fixed direct provider session state cleanup when direct config is disabled, when diagnostics stops routing, and when preview mode simulates disabled routing.
- Fixed false restore-failure prompts on quit when routing was already disabled.
- Reduced unnecessary local gateway restarts and Codex config writes when saving connection settings that only change auto-start or other non-Codex settings.
- Added a tested route settings change planner so runtime restart and Codex config sync decisions are covered by unit tests.
- Fixed Web preview fallback version display by deriving the version from the root package through Next config.
- Fixed Web type checking in clean or concurrent build environments by generating Next route types before running TypeScript.

### Upgrade Notes

- This release keeps existing provider, credential, usage, and route settings.
- If auto-start was enabled before quitting the app, launching `v1.0.1` will apply the saved route setting again.
- Existing Codex conversations may continue using old config until a new conversation is opened or Codex is restarted.

### Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.1-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.1-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.1-x64.exe`

### Notes

- Installers are still unsigned and not notarized. Download them only from this repository's GitHub Releases page.
- macOS may show a Gatekeeper warning on first launch. Windows may show a SmartScreen warning on first launch.

## v1.0.0 Release Notes

### Release Scope

`v1.0.0` is the first stable Codex Key Switcher release. It completes the migration from the legacy macOS AppKit app to the current TypeScript, Next.js, and Electron architecture, unifies version handling, and ships provider management, local gateway routing, direct provider mode, diagnostics, usage statistics, update checks, and packaging workflows.

### Features

- Multi-provider management: add, edit, and delete providers with multiple model aliases and upstream model mappings.
- Local gateway mode: Codex connects to a stable local endpoint while the app handles provider switching, model switching, protocol adaptation, and failover.
- Direct provider mode: Responses-format providers can be written directly into the Codex config without starting a local listener.
- Protocol support: Responses, OpenAI-compatible Chat Completions, and Anthropic Messages are supported through local gateway conversion.
- Tray-first workflow: inspect connection mode, endpoint, current provider, current model, and switch providers or models from the tray.
- Diagnostics and recovery: resync Codex config, stop routing and restore the original config, prepare uninstall, copy diagnostics, and open the restore script directory.
- Usage statistics: track real local gateway requests, token usage, status codes, duration, and provider/model aggregates.
- Update checks: check GitHub Releases and open the installer asset matching the current platform.

### Fixes and Improvements

- Fixed status-bar provider switching in direct provider mode: Chat Completions providers are now blocked with a clear notification.
- Fixed provider switching after upgrades or imports that still use legacy API key storage; the app now supports old key formats when a key is actually needed.
- Fixed first launch potentially triggering a macOS local password or Keychain prompt; startup, tray refresh, and provider-list rendering no longer proactively decrypt API keys.
- Provider list cards now show model configuration as read-only; provider and model changes must go through the edit flow.
- Unified version display across About, diagnostics, update checks, and packaged installers through the desktop `app.getVersion()` value.
- Added a GitHub Releases page fallback for update checks when the GitHub API returns 403 or is rate-limited.
- Improved usage persistence so each usage record no longer exports and rewrites the whole SQLite file.
- Improved streaming response handling by parsing usage incrementally instead of buffering complete streams in memory.
- Improved stats page performance with aggregate caching and lazy loading.
- Improved gateway request performance by avoiding repeated provider lookup and decryption of all providers on a single request.
- Removed ineffective stats preloading and duplicate refreshes.
- Reduced packaged app size by shipping only the required `sql.js` runtime files.

### Data and Privacy

- API keys are stored only in the local application data directory and encrypted through Electron `safeStorage`.
- The renderer process never receives plaintext API keys directly.
- First launch, tray refresh, and provider-list rendering do not proactively decrypt API keys.
- The app reads a local key only when checking models, validating provider switches, enabling direct mode, forwarding gateway requests, or exporting providers with keys included.
- Usage statistics do not record request bodies, response bodies, or API keys.
- Local usage recording can be disabled, with configurable retention days and maximum records.

### Upgrade Notes

- When upgrading from old versions, the app supports legacy `providerId:keyId`, `apiKey`, and `apiKeys` key formats.
- If the local secure storage can no longer decrypt an old key, re-enter the API key through the edit flow and save the provider.
- If the current Codex conversation still uses an old config, open a new conversation after switching provider, model, or connection mode. Restart Codex if needed.

### Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.0-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.0-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.0-x64.exe`

### Notes

- Installers are still unsigned and not notarized. Download them only from this repository's GitHub Releases page.
- macOS may show a Gatekeeper warning on first launch. Windows may show a SmartScreen warning on first launch.
- Direct provider mode supports Responses-format providers only. Use local gateway mode for Chat Completions and Anthropic Messages providers.
- Direct provider mode does not record local request logs or token statistics.
- Only the macOS Apple Silicon installer has been generated locally so far. macOS Intel and Windows installers should be built and verified on the matching environment or CI.
