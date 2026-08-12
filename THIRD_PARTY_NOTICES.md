# Third-Party Notices

Pocket AI includes open-source dependencies. The application package lockfiles and
license metadata remain the authoritative dependency inventory; this file highlights
source code retained directly in the repository.

## AnyDoc

- Project: [firecrawl/anydoc](https://github.com/firecrawl/anydoc)
- Version: 0.1.7
- Exact upstream commit: `4a45addbd607e8b59f0c263bca26aab228e10370`
- Copyright: 2026 Sideguide Technologies Inc.
- License: MIT

Pocket AI vendors the reviewed source because mobile resource limits, cancellation and
work guards, structural slide boundaries, spreadsheet semantic checks, EPUB repeated-part
handling, and reproducible native builds require a local patch set. The original license
is retained at `modules/pocket-anydoc/rust/vendor/anydoc/LICENSE`; the local changes are
categorized in `modules/pocket-anydoc/rust/UPSTREAM.md` and `UPSTREAM.json`.

## PDF Inspector

- Project: [firecrawl/pdf-inspector](https://github.com/firecrawl/pdf-inspector)
- Package version: 0.1.7
- Exact reviewed security-fix commit: `1c32e4bd691bde83778ffef235019c8feac0c0c5`
- Copyright: 2026 Firecrawl
- License: MIT

The retained commit upgrades `lopdf` to the nesting-depth-guarded 0.42 line. This avoids
the stack-overflow denial of service affecting `lopdf` 0.41 and earlier. Pocket AI also
adds bounded PDF stream normalization, cooperative page/operator work checkpoints, and
embedded mobile CMaps. The original license is retained at
`modules/pocket-anydoc/rust/vendor/pdf-inspector/LICENSE`.

## Calamine

- Project: [tafia/calamine](https://github.com/tafia/calamine)
- Crate version: 0.36.1
- Crate source commit: `0a24c2a9f1e38c0932c1299e633270dc730db505`
- crates.io checksum:
  `5fa68281b1a76b54a62156474adb06bb380a67e07dd60656e3217152b42183f3`
- License: MIT

Pocket AI retains Calamine to preserve bounded common display semantics for binary Excel
formats and to reject oversized sparse extents, merged regions, and ODS repeat/span
expansion before dense allocation. The original license is retained at
`modules/pocket-anydoc/rust/vendor/calamine/LICENSE-MIT.md`.

## lopdf

- Project: [J-F-Liu/lopdf](https://github.com/J-F-Liu/lopdf)
- Crate version: 0.42.0
- Crate source commit: `b68476c2a067f3b5158de60cd8ebce69f72068c8`
- crates.io checksum:
  `25aab26d99567469098e64a02f42679f8965c6401263eefa31d8f2dcc37a221c`
- License: MIT

Pocket AI retains the complete 0.42.0 source and adds a 2 MiB decoder boundary for
compressed input and decompressed Flate, raw-deflate, LZW, ASCII85, and PNG-predictor
streams, including object/xref streams decoded during document load. The original
license is retained at `modules/pocket-anydoc/rust/vendor/lopdf/LICENSE`.

## Transitive Rust crates

The remaining non-vendored Rust crates are resolved exactly by
`modules/pocket-anydoc/rust/Cargo.lock`. Their package metadata and license files are
available from their respective source distributions. Maintainers must review license and
security changes whenever that lockfile or the vendored sources change; see
[`docs/document-processing.md`](./docs/document-processing.md).
