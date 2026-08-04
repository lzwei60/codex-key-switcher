# Contributing

Thanks for helping improve Codex Key Switcher.

## Development

```bash
pnpm install
pnpm dev
```

Before opening a pull request, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For release changes, also build the target installer and verify the packaged app version:

```bash
pnpm --filter @codex-key-switcher/desktop dist:mac:arm64
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' 'release/mac-arm64/Codex Key Switcher.app/Contents/Info.plist'
```

## Branch and Pull Request Rules

- Work from a feature branch, not directly on `main` or `master`.
- Open a pull request for every change that should enter the protected branch.
- Product rules, security behavior, release behavior, user data handling, and defaults require maintainer approval before merge.
- Keep changes scoped. Avoid mixing refactors, behavior changes, and formatting-only edits in one pull request.
- Include tests for business logic and regression-prone fixes.

## Version and Release Changes

- Keep `package.json`, `apps/desktop/package.json`, `apps/web/package.json`, `packages/core/package.json`, and `packages/shared/package.json` on the same version.
- GitHub Release tags use a leading `v`, for example `v1.0.0`.
- Application and package metadata use the bare semantic version, for example `1.0.0`.
- Update the user guides and release notes whenever installer names, supported platforms, update behavior, or migration behavior changes.
- Do not rename release assets unless the updater matching logic is changed in the same pull request.

## Security and Privacy

This project handles provider credentials and local gateway traffic. Do not commit real API keys, user exports, logs containing authorization headers, or local application data.

If a contribution touches credential storage, request forwarding, local gateway authorization, import/export, or usage records, document the risk and validation steps in the pull request.
