# Upstream provenance

Patch revision: `pocket-mobile-3`.

`UPSTREAM.json` is the machine-readable source of truth. All four retained
packages keep their upstream license files in their respective `vendor/`
directories. `Cargo.lock` pins the remaining registry dependency graph.

## AnyDoc

- Repository: `https://github.com/firecrawl/anydoc`
- Version: `0.1.7`
- Exact commit: `4a45addbd607e8b59f0c263bca26aab228e10370`
- License: MIT (`vendor/anydoc/LICENSE`)

Local AnyDoc source patches:

- install a cooperative runtime token and charge cancellation, 30-second
  conversion deadline, and work-budget checkpoints in package, XML, binary,
  CSV, DOC/DOCX, EPUB, ODF, PPT/PPTX, RTF, spreadsheet, shared-model, and
  Markdown-rendering loops;
- lower archive entry/total/count, XML depth/node, binary-record, table
  expansion, asset, relationship, and path limits for a mobile process;
- cache parsed archive parts and stylesheet reads, and reject repeated EPUB
  itemrefs before repeated conversion (the upstream #43 regression guard);
- preserve presentation slide boundaries as structural rules;
- retain structured image payloads and stable image-to-inline placeholder IDs;
- harden Markdown escaping, anchors, backticks, list/table rendering, and
  structure accounting;
- propagate spreadsheet display-semantics and mobile resource-limit sentinels
  from the patched Calamine dependency; and
- expose the bounded encrypted-OOXML OLE probe needed for a stable
  `encrypted_document` result.

## PDF Inspector

- Repository: `https://github.com/firecrawl/pdf-inspector`
- Package version: `0.1.7`
- Exact reviewed security-fix commit:
  `1c32e4bd691bde83778ffef235019c8feac0c0c5`
- License: MIT (`vendor/pdf-inspector/LICENSE`)

That reviewed upstream commit already selects `lopdf` 0.42.0, which contains
the nesting-depth security fix absent from the 0.41 line. Local PDF Inspector
patches additionally:

- embed the four required Adobe UCS2 CMaps instead of reading build-machine
  filesystem paths at runtime;
- add cooperative cancellation/deadline/work checkpoints per page and inside
  the dominant content-operator loop;
- normalize decoded streams immediately after document load with limits of
  2 MiB per stream, 8 MiB aggregate, and 4,096 streams; and
- build the library without default `lopdf` time features, gate `env_logger`
  and CLI binaries behind an unused `cli` feature, and rely on the root
  `log/release_max_level_off` feature for production builds.

## Calamine

- Repository: `https://github.com/tafia/calamine`
- Crate version: `0.36.1`
- Crate source commit: `0a24c2a9f1e38c0932c1299e633270dc730db505`
- crates.io checksum:
  `5fa68281b1a76b54a62156474adb06bb380a67e07dd60656e3217152b42183f3`
- License: MIT (`vendor/calamine/LICENSE-MIT.md`)

Local Calamine patches preserve common percentage, currency/accounting,
number, date, and time display strings for XLS/XLSB while returning a stable
sentinel for unsupported custom formats. They also reject, before dense range
allocation, workbooks whose sparse extent or explicit cells exceed 250,000,
whose merged-region count exceeds 4,096, or whose ODS row/column repeats and
spans would cross those limits. The same checks cover XLS, XLSB, XLSX/XLSM,
and ODS read paths.

## lopdf

- Repository: `https://github.com/J-F-Liu/lopdf`
- Crate version: `0.42.0`
- Crate source commit: `b68476c2a067f3b5158de60cd8ebce69f72068c8`
- crates.io checksum:
  `25aab26d99567469098e64a02f42679f8965c6401263eefa31d8f2dcc37a221c`
- License: MIT (`vendor/lopdf/LICENSE`)

The complete 0.42.0 source is retained. A local decoder boundary limits
compressed input and decompressed Flate, raw-deflate, LZW, ASCII85, and PNG
predictor output to 2 MiB per stream, including object/xref streams decoded
during `Document::load`. It returns a typed resource-limit error instead of
allocating an unbounded `Vec`.

## Pocket AI wrapper changes (not upstream-source patches)

The retained C ABI, private-root path/stat/hash verification, per-format source
limits, serialized conversion gate, panic containment, bounded JSON envelopes,
structural/overlapping chunk projection, overview and BM25-ish selection,
XLSX hidden-cell/date1904/display projector, asset validation/materialization,
and explicit-release fail-closed handle cache live in Pocket AI's own `src/`
and `include/` trees. They are intentionally not represented as modifications
to the four upstream packages above.
