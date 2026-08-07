# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting as the primary disclosure channel for security issues in Pocket AI.

If private reporting is available for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Share the report privately with the details listed below.

Do not post exploit details, secrets, private tokens, or proof-of-concept payloads in a public issue, pull request, discussion, or review comment.

If GitHub private vulnerability reporting is unavailable for any reason, open a minimal public issue without exploit details and ask the maintainers for a private follow-up channel.

## Supported versions

Security fixes are only planned for:

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Current `main` branch | Yes |
| Older releases | No |

## What to include

Please include:

- A short description of the issue and why it matters
- The affected app version, release tag, or commit SHA if known
- The affected platform, device, and OS version
- The model, provider, or source involved if the issue is model-specific
- Clear reproduction steps or a minimal proof of concept
- The expected result and the actual result
- Any relevant logs, screenshots, crash traces, or configuration details
- Any mitigations or workarounds you have already tried

Send sensitive details only through the private reporting flow.

## Response target

Maintainers aim to:

- Acknowledge new reports within 5 business days
- Share an initial triage outcome or next-step update within 10 business days

Response and remediation timelines can vary with severity, reproducibility, and maintainer availability.

## Untrusted document processing

Pocket AI treats every attached document as hostile input. Office archives, legacy OLE
files, OpenDocument packages, RTF, EPUB, CSV, and PDF are parsed locally by a pinned Rust
dependency graph behind a small native boundary. The app does not execute macros,
embedded objects, scripts, or executables, recursively open embedded documents, or fetch
external document resources.

Document handling is constrained by format-specific source limits and global archive,
XML, expansion, work, output, asset, cache, and deadline budgets. Heavy conversions are
serialized. Cancellation and stale-request checks prevent an old document result from
entering a different chat or model request. Native code revalidates that the source is a
regular file inside the app-owned attachment directory and rejects traversal, symlinks,
external `content://` URIs, and files that change during a request.

Security reports involving parser hangs, excessive memory use, semantic spreadsheet
corruption, path escape, FFI ownership, or crafted archive/PDF crashes are in scope. Use
private vulnerability reporting and do not attach a real private document to a public
issue.
