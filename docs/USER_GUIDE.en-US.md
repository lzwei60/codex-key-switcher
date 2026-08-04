# Codex Key Switcher User Guide

Codex Key Switcher is a desktop app for managing Codex API keys, providers, model aliases, and a local gateway. It lets Codex connect to a stable local endpoint while the app routes requests to the selected upstream provider and model.

## Supported Platforms

- macOS Apple Silicon: use `Codex-Key-Switcher-1.0.0-arm64.dmg`
- macOS Intel: use `Codex-Key-Switcher-1.0.0-x64.dmg`
- Windows x64: use `Codex-Key-Switcher-Setup-1.0.0-x64.exe`

The current installers are unsigned and not notarized. macOS or Windows may show a security warning on first install.

The current stable version is `v1.0.0`. The version shown in About and Settings -> Updates comes from the desktop `app.getVersion()` value.

## First Run

1. Install and start Codex Key Switcher.
2. Open Settings and confirm the `Codex Config Directory`. The default is `~/.codex`.
3. Open Providers and click Add Provider.
4. Enter provider name, API key, base URL, API format, and model mapping.
5. Click Check on the model row to verify connectivity.
6. Save the provider.
7. If the local gateway is enabled, restart Codex after adding the first provider, or close the current Codex conversation and open a new one.

## Providers

Use the Providers page to add, edit, and delete provider configurations.

Each provider contains:

- Name: shown in the UI and tray menu.
- API Key: stored locally on this machine.
- Base URL: upstream API endpoint.
- API Format: upstream API protocol.
- Model Alias: model name exposed to Codex.
- Upstream Model: real model name sent to the provider.

Supported API formats:

- Responses
- Chat Completions
- Anthropic Messages

Recommended DeepSeek Chat Completions configuration:

- Base URL: `https://api.deepseek.com`
- API Format: `Chat Completions`
- Upstream Model: for example `deepseek-v4-pro` or `deepseek-v4-flash`

## Model Check

When adding or editing a model, click Check to verify that the model is reachable.

The page only shows:

- Check passed
- Check failed

Detailed errors are shown through the global Message notification.

For new providers, an API key is required before checking a model. When editing an existing provider, the app can use the locally saved key if the API key field is left empty.

## Local Gateway

The local gateway makes Codex connect to a local endpoint. Codex Key Switcher then forwards requests to the selected provider and model.

Default endpoint:

```text
http://127.0.0.1:3456/v1
```

When the local gateway is enabled, the app writes the local endpoint into the Codex config.

Restart Codex, or close the current conversation and open a new one, in these cases:

- You added the first provider while the local gateway is enabled.
- You re-enabled the local gateway after quitting the app.
- The current Codex conversation is still using an old config.

When switching providers or models, the app suggests opening a new conversation because existing conversations may continue using old context.

## Direct Provider Mode

Direct provider mode does not start the local gateway. It writes the current provider base URL, API key, and upstream model directly into the Codex config.

Direct mode limitations:

- It supports Responses-format providers only.
- Chat Completions and Anthropic Messages providers must use local gateway mode so the local gateway can perform protocol conversion.
- Direct mode does not record local request logs or token statistics.
- In direct mode, switching to a Chat Completions provider from the tray menu is blocked and the app shows a reason.

After switching the direct provider or model, close the current Codex conversation and open a new one. If the new conversation still does not pick up the change, restart Codex.

## Tray Menu

The app is tray-first. Closing the main window hides it, but the app keeps running in the tray.

The tray menu includes:

- Gateway endpoint
- Running status
- Current provider
- Current model
- Provider submenu
- Model submenu for the current provider
- Open main window
- Start or stop local gateway
- Quit

When you choose Quit, the app stops the local gateway and tries to restore the original Codex config. Restart Codex or open a new conversation afterwards.

## Settings

The Settings page has three tabs.

General:

- Codex Config Directory: default `~/.codex`; can be selected manually.
- Open at Login: supported on macOS and Windows.
- Open Hidden: mainly supported on macOS.
- Language: Chinese or English.
- Appearance: system, light, or dark.

Gateway:

- Enable local gateway
- Auto-start local gateway
- Listen address
- Listen port
- Allow LAN listen
- Failover
- Check port

Updates:

- Check the latest version from GitHub Releases
- Show the current version, latest version, and current platform
- Open the matching installer download link for the current platform
- Open release notes

Updates are installed manually. Because the installers are unsigned, macOS or Windows may show a security warning on first launch.

The default port is `3456`. Valid ports are from `1024` to `65535`.

Privacy:

- Local usage recording can be disabled.
- Retention days can be configured.
- Maximum retained records can be configured.
- Changes affect future local gateway requests and do not backfill historical data.

## Usage Stats

The Stats page shows real usage data recorded by the local gateway.

It includes:

- Real request count
- Real token usage
- Success rate
- Average duration
- Usage trend line chart
- Provider stats
- Model stats
- Request logs

Stats are recorded only when requests go through the local gateway.

Stats do not record request bodies, response bodies, or API keys. After local usage recording is disabled, new requests are not written into the local usage database.

## Diagnostics and Recovery

The Diagnostics page checks local gateway status, Codex config status, and backup availability.

Common actions:

- Resync Codex config
- Stop gateway and restore original Codex config
- Prepare uninstall
- Open restore script directory
- Copy diagnostics report
- Refresh

If the app exits unexpectedly or Codex config is not restored, use the Diagnostics page to recover it.

## Before Uninstalling

Before uninstalling, open Diagnostics and click Prepare Uninstall. The app will:

- Stop the local gateway
- Restore the original Codex config
- Disable route-related settings

After that, remove the app.

## FAQ

### Codex requests fail or return 502

Check the following:

- The local gateway is running.
- The current provider has a valid model.
- The API key is correct.
- The base URL matches the selected API format.
- The model check passes.

If you just enabled the local gateway, restart Codex or open a new conversation.

### The app keeps running after I close the window

This is expected. Closing the window hides the main UI. The app keeps running in the tray. To exit completely, choose Quit from the tray menu.

### Why does the app ask me to restart Codex after quitting?

On quit, the app stops the local gateway and restores the original Codex config. Codex needs to reload its config, so restart Codex or open a new conversation.

### Why should first launch not ask for my local machine password?

First launch, tray refresh, and provider-list rendering do not proactively decrypt API keys, so the app normally should not ask for the local machine password immediately after installation.

macOS may show a Keychain authorization prompt when the app actually needs to read a local key, for example when checking a model, enabling direct mode, forwarding a local gateway request, or exporting providers with API keys included. If the prompt appears on first launch before any action, confirm that the installed version is `v1.0.0` or newer.

### Provider switching still says the local API key is missing after upgrading

`v1.0.0` automatically supports legacy key storage formats when a key is actually needed. If the error still appears, the local secure storage may no longer be able to decrypt the old key, or application data may have been migrated without the system credential store. Re-enter the API key through the edit flow and save the provider.
