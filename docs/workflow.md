# Project workflow

This document describes how changes flow through the repository: branches, pull requests, CI, and releases.

## Branching model

- Default branch: `main`
- Development style: trunk-based (no long-lived `develop` branch)
- All changes land via pull requests to `main`

## Pull requests

### PR title (required)

This repository uses squash merge and automated releases.

Your **PR title** must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

- `feat: ...` (new user-facing behavior)
- `fix: ...` (bug fixes)
- `docs: ...` (documentation-only changes)
- `refactor: ...`, `test: ...`, `chore: ...`, etc.

Scopes are optional (`feat(ui): ...` is fine).

### CI expectations

PRs are expected to keep `main` green. Typical required checks include:

- CI (typecheck + lint + tests)
- Dependency Review
- PR title validation

## Releases (automated)

Releases are automated with **Release Please**:

- It opens/updates a Release PR after changes land on `main`.
- Merging the Release PR updates versions + `CHANGELOG.md` and creates a git tag and GitHub Release.

If `main` is protected with required checks, configure a PAT secret (for example `RELEASE_PLEASE_TOKEN`) so CI runs on Release PRs.

## Versioning

This project uses SemVer:

- `fix:` → PATCH bump
- `feat:` → MINOR bump
- `feat!:` / `BREAKING CHANGE:` → MAJOR bump

Canonical version locations:

- `app.json -> expo.version`
- `package.json -> version` (kept equal to `expo.version`)

