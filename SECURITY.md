# Security Policy

## Reporting a Vulnerability

Please do not disclose security issues publicly before maintainers have reviewed them.

Report vulnerabilities through GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled yet, open a minimal issue that says you need a private security contact and do not include exploit details, API keys, tokens, logs, or user data.

## Sensitive Areas

Treat these areas as security-sensitive:

- Provider API key storage and import/export.
- Local gateway authorization.
- Upstream request forwarding and header handling.
- Usage logs and diagnostic output.
- Release signing, notarization, and installer packaging.

## Credential Handling

- Provider API keys are stored locally and encrypted through Electron `safeStorage`.
- The renderer process should never receive plaintext API keys.
- Startup, tray refresh, diagnostics, and provider-list rendering should not decrypt API keys.
- Plaintext key reads should be limited to model checks, provider-switch validation, direct provider config writes, local gateway forwarding, and exports where the user explicitly chooses to include API keys.
- Usage records and diagnostics must not include request bodies, response bodies, authorization headers, or API keys.

## Supported Versions

| Version | Supported |
| --- | --- |
| `1.0.x` | Yes |
| `< 1.0.0` | No |

Only the latest stable `1.0.x` release and the current protected branch are supported for security fixes.
