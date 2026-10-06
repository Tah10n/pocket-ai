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

Source updates (`opened`, `reopened`, `synchronize`) and base-branch retargeting run
the full CI policy. A newer source/base run cancels older CI for the same PR;
different PRs, optional QA and push/release workflows use independent groups.
Ordinary title/body edits run a lightweight metadata job and the PR title check.
Their skipped source jobs use distinct metadata check names, so they cannot replace
an existing failed required `verify` result on the unchanged revision.

Labels and optional Android checkboxes are handled by the separate **Android QA**
workflow. Adding a request, changing its selected pack, reopening/retargeting the PR,
or updating its source runs deterministic release verification before the requested
Android pack. Unrelated labels and prose edits do not repeat or cancel expensive QA.
The existing pack priority, release APK checks, and local-only destructive pack
policy remain in force. Each requested QA job can supersede the older job for the
same PR after its dependencies pass.

Native Android jobs always retain their small `latest-report.json` result for one
day. Screenshots, logcat and other bulky diagnostics are uploaded on failure,
cancellation, or an explicit Android QA label/checked box. Requested optional QA
retains diagnostics, and all/document labels still retain the APK for one day.
Cancellation uploads are best effort within GitHub's cancellation grace period;
native signal handlers and emulator action cleanup remain unchanged.

Native scope still examines the whole PR. A docs/report-only push to a PR with
native changes conservatively reruns Android API 32–35 and iOS. Reusing native
proof across such revisions and sharing one APK across emulator jobs are deferred.

Native builds cache Rust dependencies separately for Android and iOS, keyed by
the pinned toolchain, Cargo inputs and native build scripts. Workspace crates are
rebuilt. Android native and requested QA jobs share only Gradle dependency downloads
and wrapper distributions from the isolated QA Gradle home, restored after `npm ci`.
Generated app/build outputs, APKs, provenance and prior verification results are
not cached. A cold or missing cache still runs the complete build and verification.
Docs/report edits leave these dependency keys unchanged; lockfile/build-policy
changes select new primary keys. Download-only Gradle fallback restores can still
reuse content-addressed dependencies. Native patch and SDK/setup-script edits remain in native scope.

The scope and QA request logs record the public action and head/base commit IDs
without dumping PR prose or the full event payload. This distinguishes future
source/base events from metadata events when diagnosing duplicate runs.

PRs are expected to keep `main` green. Typical required checks include:

- CI (typecheck + lint + tests)
- Dependency Review
- PR title validation

Bootstrap note:

- If the repository is adding these workflows for the first time, do not require them on the same bootstrap PR.
- Merge the workflow PR first, let the checks exist on `main`, then enable them as required branch protections.

## Releases (automated)

Releases are automated with **Release Please**:

- It opens/updates a Release PR after changes land on `main`.
- Merging the Release PR updates versions, `.release-please-manifest.json`, and `CHANGELOG.md`. The push workflow cancels stale runs, runs deterministic release verification plus clean Android and iOS native release gates against the event SHA, confirms that SHA is still the current `main` head, and only then creates a git tag and GitHub Release.
- EAS production builds are the only store-upload artifact path and use remote, auto-incremented Android and iOS developer-facing versions. Initialize both platforms from their latest accepted store builds before the first production build after enabling this workflow. Local Android bundles and Xcode archives are diagnostic only; `eas build:version:sync` does not reserve a new store number.

If `main` is protected with required checks, configure a PAT secret (for example `RELEASE_PLEASE_TOKEN`) so CI runs on Release PRs.

## Versioning

This project uses SemVer:

- `fix:` → PATCH bump
- `feat:` → MINOR bump
- `feat!:` / `BREAKING CHANGE:` → MAJOR bump

Canonical version locations:

- `app.json -> expo.version`
- `package.json -> version` (kept equal to `expo.version`)
- `.release-please-manifest.json` (Release Please's current release state)
