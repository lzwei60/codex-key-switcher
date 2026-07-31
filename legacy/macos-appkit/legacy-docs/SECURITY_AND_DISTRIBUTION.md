# Security and Distribution Notes

Chinese version: [SECURITY_AND_DISTRIBUTION.zh-CN.md](SECURITY_AND_DISTRIBUTION.zh-CN.md)

## Local proxy

Codex Key Switcher runs a local Responses-compatible proxy so Codex can keep one stable `base_url` while the app switches upstream providers. Upstream providers can use native Responses, OpenAI-compatible Chat Completions, or Anthropic Messages; the proxy adapts requests and responses back to the Responses shape Codex expects.

Public builds should keep the listen address on `127.x.x.x`. Exposing the proxy on `0.0.0.0` or a LAN IP can leak provider metadata and makes the local gateway reachable by other machines on the network.

The gateway requires an authorization token for model requests. The status endpoint returns redacted details unless the request is authorized.

## API key storage

By default, API keys are stored in:

`~/Library/Application Support/AIKeySwitcher/api-keys.json`

The file and parent directory are restricted to the current macOS user. This avoids repeated Keychain permission prompts, but it is still local file storage, not hardware-backed secret storage.

For broad or enterprise distribution, add an optional Keychain backend and a migration path from the local JSON file.

## Codex configuration changes

When local routing is enabled, the app updates the selected Codex configuration directory:

- `config.toml`
- `auth.json`
- `models_cache.json` when present

The app creates managed backups and a standalone restore script:

`~/Library/Application Support/AIKeySwitcher/restore-codex-config.command`

Users should restore the original Codex configuration before uninstalling the app. If the app is removed without restoring, they can run the restore script manually.

## Release signing

Local development builds may use ad-hoc signing. Public releases must use:

- stable reverse-DNS bundle identifier
- Developer ID Application signing
- hardened runtime
- timestamp signing
- notarized and stapled DMG
- signed auto-update channel before wide distribution

Run `scripts/run-release-checks.sh` before packaging, then `scripts/package-dmg.sh`, then `scripts/notarize-dmg.sh`.
