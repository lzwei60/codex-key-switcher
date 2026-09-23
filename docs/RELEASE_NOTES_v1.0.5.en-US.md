# v1.0.5 Release Notes

## New Features

- Add configurable local-gateway failover attempts, total timeout, failure threshold, cooldown, and half-open concurrency.
- Add provider priority and per-provider fallback model mappings for failover requests.
- Record every failover attempt with request ID, attempt number, final-attempt state, error category, provider, model, status, and duration.

## Fixes and Improvements

- Restart the local gateway when its listen address or port changes instead of leaving the old listener active.
- Clear stale circuit-breaker state when failover is disabled.
- Continue the failover chain when a backup provider credential cannot be read, while recording the credential error.
- Release half-open circuit permits on every attempt outcome, including exceptions.
- Preserve existing providers, credentials, usage data, and route settings during upgrade.

## Upgrade and Risk Notes

- Existing route settings are preserved. New failover settings use conservative defaults when absent.
- Chat Completions and Anthropic models require local gateway mode; direct provider mode requires Responses.
- Installers are unsigned and not notarized. Download them only from this repository's GitHub Releases page.

## Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.5-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.5-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.5-x64.exe`
- Linux x64: `Codex-Key-Switcher-1.0.5-x86_64.AppImage` and `Codex-Key-Switcher-1.0.5-amd64.deb`

The packaged application names remain fixed for upgrade compatibility: `Codex Key Switcher.app` on macOS, `codex-key-switcher.exe` inside the Windows installer, and `codex-key-switcher` inside Linux packages.
