# Contributing to Pocket AI

Thanks for contributing. This document explains how to report issues, propose changes, and prepare contributions that are practical to review and maintain.

## Code of conduct

All participation in this project is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Repository scope

This repository contains the Pocket AI app, supporting documentation, and project scripts.

If you plan to work on a non-trivial change, open an issue first so the scope, constraints, and expected outcome are clear before implementation starts.

## Ways to contribute

Contributions that help most:

- Bug reports with clear reproduction steps
- Feature requests grounded in a real user problem
- Documentation improvements
- Focused fixes with tests or verification notes
- UI feedback with screenshots or screen recordings

## Before opening an issue

Please:

- Search existing issues and pull requests first
- Reproduce the problem on the latest code you can access
- Keep one problem or proposal per issue when possible
- Use a clear title that describes the user-facing problem

## Reporting bugs

Good bug reports reduce review time significantly. Include:

- Device model and platform
- OS version
- App version, commit, or branch if known
- Exact reproduction steps
- Expected result
- Actual result
- Screenshots, logs, or recordings when relevant
- Model name and source if the issue is model-specific

If the problem is intermittent, say so and describe the failure rate or the conditions that seem to trigger it.

## Requesting features

Feature requests are most useful when they explain:

- The problem you are trying to solve
- Who benefits from the change
- What behavior you expect
- Why the current behavior is insufficient
- Any alternatives you considered

## Contribution workflow

For most code changes, the expected workflow is:

1. Fork the repository.
2. Create a focused branch from `main`.
3. Make one logical change at a time.
4. Run the relevant checks locally.
5. Commit with a clear message.
6. Open a pull request to `main` with a **Conventional Commit-style PR title** (required).
7. Complete the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md).

## Development setup

Pocket AI is a native Expo / React Native project. A native development environment is required for local inference features.

### Prerequisites

- Node.js and npm
- Android Studio for Android work
- Xcode for iOS work
- A working native toolchain for Expo native builds

### Install dependencies

```bash
npm install
```

### Run locally

```bash
npm start
```

```bash
npm run android
```

```bash
npm run ios
```

## Quality checks

Run the relevant checks before opening a pull request:

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

For most app changes, the default verification gate is:

```bash
npm run verify:mobile-change
```

If your change affects Android behavior or visible UI flows, also run:

```bash
npm run verify:mobile-change:android
```

## Localization

When a change adds or edits user-facing copy:

- Add translation keys to both [`src/i18n/locales/en.json`](./src/i18n/locales/en.json) and [`src/i18n/locales/ru.json`](./src/i18n/locales/ru.json)
- Render copy through `useTranslation()` and `t(...)` instead of inline literals
- Keep pluralized keys complete for both locales
- Run `npm test`; locale parity is covered by [`__tests__/i18n/translations.test.ts`](./__tests__/i18n/translations.test.ts)

Avoid landing mixed-language UI or English-only strings in translated screens.

## PR titles (required)

This repository uses **squash merge** and **automated releases** (Release Please).

That means the **PR title** must follow the [Conventional Commits](https://www.conventionalcommits.org/) format so versioning and changelog can be generated automatically:

- `feat`: new user-facing behavior
- `fix`: bug fixes or regressions
- `docs`: documentation-only changes
- `test`: test coverage or test-only changes
- `refactor`: internal restructuring without intended behavior change
- `chore`: tooling, configuration, or maintenance work

Examples:

- `feat: add storage warning before large model download`
- `fix: prevent duplicate conversation restore on app launch`
- `docs: clarify Android release setup`

Notes:

- Scopes are optional (`feat(ui): ...` is fine, but not required).
- Dependabot PRs are exempt from the title rule.

## Code and documentation expectations

Please keep changes:

- Focused on a single logical improvement
- Consistent with the existing project structure and naming
- Backed by tests when behavior changes
- Backed by updated documentation when public behavior or setup changes

Avoid unrelated refactors in the same pull request unless they are necessary to make the fix safe.

## Pull request guidelines

Before opening a pull request:

- Follow the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md)
- Link the related issue if one exists
- Explain the problem and the chosen approach
- List the checks you ran
- Include screenshots for UI changes
- Call out platform-specific impact
- Note any localization, migration, or model-compatibility impact
- Keep the diff as small as reasonably possible

Pull requests that are easier to review usually:

- Solve one problem
- Include verification notes
- Avoid unnecessary formatting churn
- Add or update tests near the changed behavior

## Review and merge process

All pull requests are reviewed against product fit, maintenance cost, correctness, and release risk.

Maintainers may:

- Request revisions before merge
- Ask to narrow or split a large pull request
- Close changes that are stale, duplicate existing work, or do not fit the current roadmap

Keeping pull requests focused and well-verified gives them the best chance of moving quickly.

## Security and sensitive reports

Do not post secrets, access tokens, private keys, or detailed exploit instructions in public issues.

If you believe you found a security vulnerability:

- Prefer private reporting channels if GitHub private reporting is enabled
- Otherwise open a minimal issue without exploit details and ask for a private follow-up

## Community expectations

Be respectful, specific, and constructive. Assume good intent, keep feedback technical, and focus on improving the product. If a discussion becomes heated or unproductive, step back and return to the issue with concrete technical context.

## License

By contributing to this repository, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
