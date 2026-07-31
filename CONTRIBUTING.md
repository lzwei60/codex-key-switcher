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

## Branch and Pull Request Rules

- Work from a feature branch, not directly on `main` or `master`.
- Open a pull request for every change that should enter the protected branch.
- Product rules, security behavior, release behavior, user data handling, and defaults require maintainer approval before merge.
- Keep changes scoped. Avoid mixing refactors, behavior changes, and formatting-only edits in one pull request.
- Include tests for business logic and regression-prone fixes.

## Security and Privacy

This project handles provider credentials and local gateway traffic. Do not commit real API keys, user exports, logs containing authorization headers, or local application data.

If a contribution touches credential storage, request forwarding, local gateway authorization, import/export, or usage records, document the risk and validation steps in the pull request.
