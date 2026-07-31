# Codex Key Switcher Release Checklist

Chinese version: [RELEASE_CHECKLIST.zh-CN.md](RELEASE_CHECKLIST.zh-CN.md)

## App safeguards

- First-run guide explains that Codex config will be pointed at the local routing proxy.
- Local routing is enabled by default for new users.
- Local routing only allows 127.x.x.x listen addresses by default. LAN listening must not be enabled in public builds without an explicit advanced warning.
- Gateway status is redacted for unauthenticated requests.
- CORS responses are restricted to `http://127.0.0.1` instead of wildcard origins.
- Accepted client sockets disable SIGPIPE to avoid crashes when clients disconnect early.
- Settings > Routing provides a manual port check and blocks saving when the chosen port is already used by another process.
- Port conflicts are checked across same-port listeners before binding, then automatically fall back to the next available port within 20 attempts on app startup.
- Settings > Diagnostics shows gateway status, Codex proxy status, restore backup status, provider, model, and paths.
- Settings > Diagnostics provides restore, resync, restore-script folder, and diagnostics-copy actions.
- Environment variable copying requires confirmation and clears the clipboard after 2 minutes.
- Provider metadata and usage files are written with owner-only permissions.

## Automated checks

- Run `scripts/run-release-checks.sh` before packaging.
- Resolve all static analyzer warnings before public distribution.
- The script allows local development with `local.*` bundle identifiers, but public releases must replace them.

## Before public distribution

- Build with `scripts/build-release.sh`.
- Package a DMG with `scripts/package-dmg.sh`.
- Build with a stable bundle identifier instead of `local.ai-key-switcher` before public distribution.
- Sign with a Developer ID Application certificate by setting `CODEX_KEY_SWITCHER_SIGN_IDENTITY`. Non-ad-hoc builds use hardened runtime and timestamp signing.
- Submit and staple the DMG with `scripts/notarize-dmg.sh` after setting `APPLE_NOTARY_ID`, `APPLE_TEAM_ID`, and `APPLE_NOTARY_PASSWORD`.
- Add a signed auto-update channel, such as Sparkle, before wide distribution.
- Verify restore behavior on a clean macOS user account.
- Verify Codex config restore before uninstalling the app.
- Test with missing `.codex`, missing `auth.json`, missing `models_cache.json`, occupied port, and corrupted provider storage.
- Test provider failures: 401/403, 404 endpoint for Responses / Chat Completions / Anthropic Messages, 429 rate limit, 5xx failover, streaming disconnect, non-streaming output converted back to Responses, and real streaming text/tool-call conversion for Chat Completions and Anthropic Messages.

## Security notes

- Do not include API keys in logs, screenshots, crash reports, or diagnostics.
- The local JSON key store avoids repeated Keychain prompts, but it is not equivalent to hardware-backed secret storage.
- For enterprise distribution, add an optional Keychain storage backend and a migration path from local JSON.
- Treat `~/Library/Application Support/AIKeySwitcher/api-keys.json` as sensitive user data.
- Do not ask users to paste API keys into issue reports.
