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

## Supported Versions

Until the first stable release, only the current `main` branch is supported.
