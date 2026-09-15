# v1.0.4 Release Notes

## New Features

- Configure Responses, Chat Completions, or Anthropic Messages independently for each model in one provider.
- Configure per-model reasoning and image-input capabilities, including inherit-from-provider defaults.
- Fetch upstream model lists, check individual models, and confirm before saving unchecked models.
- Route each request to the selected model within the current provider using the request `model` value.
- Generate a fuller Codex model Catalog and validate Catalog completeness before use.
- Add regression coverage for protocol conversion, Catalog validation, timeouts, interrupted streams, and cross-model routing.
- Add bilingual labels and runtime messages across the tray menu, provider, diagnostics, settings, and usage views.

## Fixes

- Fixed native Responses streams that begin with text deltas or close early; abnormal streams now fail explicitly instead of being reported as completed.
- Fixed system instructions, function-tool history, and full-message conversion for Chat Completions and Anthropic Messages.
- Fixed cross-protocol requests that only carry a response ID; they now return a clear 400 before contacting the upstream.
- Fixed forwarding of unsupported image or file history by rejecting it explicitly.
- Fixed missing phase-specific timeouts for request bodies, upstream headers, normal requests, and idle streams.
- Fixed false client-disconnect detection after normal request-body reads.
- Fixed protocol paths, model mapping, and headers for DeepSeek and similar OpenAI-compatible upstreams.
- Fixed duplicate aliases, dropped model capability fields, and stale model-check state after edits.

## Improvements

- Improved the model editor layout and advanced model capability controls.
- Improved runtime error localization and bilingual UI consistency.
- Improved Catalog cache-template matching and complete fallback-field generation.
- Improved default-model switch notifications to clarify that existing sessions do not hot-switch.
- Improved streaming backpressure, client-disconnect cleanup, and failed-request usage recording.

## Upgrade and Risk Notes

- Existing providers, credentials, usage data, and connection settings are preserved.
- Reload the Codex model list after changing a model or connection mode. Cross-protocol continuation requires the full visible history.
- Chat Completions and Anthropic models require local gateway mode; direct provider mode requires Responses.
- Installers are unsigned and not notarized. Windows and Linux installers still require smoke testing on their target systems.

## Installers

- macOS Apple Silicon: `Codex-Key-Switcher-1.0.4-arm64.dmg`
- macOS Intel: `Codex-Key-Switcher-1.0.4-x64.dmg`
- Windows x64: `Codex-Key-Switcher-Setup-1.0.4-x64.exe`
- Linux x64: `Codex-Key-Switcher-1.0.4-x86_64.AppImage` and `Codex-Key-Switcher-1.0.4-amd64.deb`
