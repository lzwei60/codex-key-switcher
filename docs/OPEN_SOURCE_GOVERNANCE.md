# Open Source Governance

This repository is intended to be public, but releases and protected branch merges should stay maintainer-controlled.

## Branch Strategy

- Protected branch: `main`.
- Compatibility alias if needed: `master` can be created only if an external workflow requires that exact name.
- All product work should enter through pull requests.
- Direct pushes to the protected branch should be disabled.

## Required GitHub Rules

Configure these in GitHub after creating the repository:

1. Go to `Settings > Branches > Branch protection rules`.
2. Add a rule for `main`.
3. Enable `Require a pull request before merging`.
4. Enable `Require approvals` and set required approvals to at least `1`.
5. Enable `Require review from Code Owners`.
6. Enable `Dismiss stale pull request approvals when new commits are pushed`.
7. Enable `Require status checks to pass before merging`.
8. Select the `Quality gate` CI status check.
9. Enable `Require branches to be up to date before merging`.
10. Enable `Restrict who can push to matching branches` and include only maintainers.
11. Disable `Allow force pushes`.
12. Disable `Allow deletions`.
13. If available on your plan, enable `Require conversation resolution before merging`.

Repeat the same rule for `master` only if you choose to use `master` as the protected branch.

## Maintainer Approval Scope

Maintainer approval is required for:

- Product rules, defaults, and user-facing workflows.
- Credential storage, import/export, masking, or deletion.
- Local gateway authorization and request forwarding.
- Logging, diagnostics, usage statistics, and telemetry-like behavior.
- Build, signing, notarization, release, and installer changes.
- Dependency upgrades that affect runtime behavior or packaging.

## Stable Release Policy

- `v1.0.0` is the first stable release line.
- Stable tags must be immutable after publication. If an installer must be replaced, publish a new patch version such as `v1.0.1`.
- Release notes must include supported platforms, installer names, unsigned/notarization status, upgrade notes, and known limitations.
- The latest GitHub Release must use a tag that matches the desktop app version.
- At minimum, each release candidate must pass `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Platform installers should be built and verified on matching environments before they are listed as available release assets.

## Repository Setup Checklist

Before making the repository public:

- Replace `@lzwei60` in `.github/CODEOWNERS`.
- Confirm the license owner name in `LICENSE`.
- Run a secret scan across files and Git history.
- Create the GitHub repository as public.
- Add the remote origin.
- Push the default branch.
- Enable branch protection rules.
- Enable private vulnerability reporting in `Settings > Code security`.
- Add repository topics and a clear project description.
