# Document QA and Benchmarks

Last updated: 2026-08-07

Pocket AI's document QA uses only checked-in synthetic fixtures. The corpus covers DOCX,
PPTX, XLSX, EPUB, and text PDF success paths; corrupt, encrypted, resource-limit, archive
expansion, and deep-XML failures; stop, thread-switch, and model-switch races; four-document
context; 100-slide, 40-page, and 20-sheet stress cases; and four sequential documents.

## Deterministic host checks

From the public app root, verify the fixture hashes, scenario routing, report schema,
privacy contract, and build-provenance helpers with:

```sh
npm run anydoc:qa:verify
```

This gate does not build Rust or launch Android. Every fixture is pinned by exact byte
length and SHA-256. Plans can be regenerated repeatably under
`artifacts/document-benchmarks/`:

```sh
npm run anydoc:benchmark:plan:host
npm run anydoc:benchmark:plan:android
```

Build and run the release host benchmark with the pinned Rust toolchain and lockfile:

```sh
npm run anydoc:benchmark:run:host
```

The package command runs the equivalent build first:

```sh
cargo +1.94.0 build --manifest-path ./modules/pocket-anydoc/rust/Cargo.toml --locked --release --bin pocket-anydoc-host-bench
node ./scripts/document-benchmark.js run-host
```

The host protocol reserves the executable name `pocket-anydoc-host-bench` (with `.exe` on
Windows). It accepts one JSONL operation per line (`prepare`, `select`, or `release`) and
returns one bounded JSON envelope per line. Responses add only the process peak RSS from
the OS. The harness starts a fresh runner for every warmup or measured iteration so an
earlier workload cannot contaminate a later iteration's lifetime peak; all fixtures inside
one sequential benchmark iteration still share that iteration's process. The runner does
not log paths, document text, or response content. A response may
take up to the native 30-second conversion deadline, while the outer harness waits 45
seconds before terminating its owned runner. The report hashes and sizes the release
runner executable, which statically contains the Rust engine. A plan or schema-only check
is not a host performance result.

## Android document scenarios

Run the functional pack against a current-head release APK on a dedicated emulator or
test device:

```sh
npm run android:scenarios:documents
```

This preconditioned pack remains an explicit maintainer/device command. Hosted labels,
the default hosted pack, and `android-pack-all` deliberately exclude it.

The device must have one loaded local model. The model-switch race additionally requires
a second downloaded model. The runner stages only the pinned fixtures, selects them
through Android DocumentsUI, and removes the exact staged files and QA-created chats when
the scenario ends.

Document scenarios use a sentinel-only evidence policy. Reports retain synthetic fixture
IDs, fixed sentinel IDs, bounded timings, RSS/UI-probe counts, and allowlisted error codes.
They do not persist document text, prompts, display names, file paths, UI dumps,
screenshots, logcat, command output, or raw failure messages. Failures and skips use only
allowlisted stage/code pairs.

The stop, thread-switch, and model-switch races continue checking for stale sentinels for
35 seconds after invalidation: the native 30-second wall deadline plus a five-second
delivery margin.

## Android release benchmark

Run the dedicated benchmark pack only when a release APK built from the current source is
installed:

```sh
npm run android:scenarios:document-benchmark
npm run anydoc:benchmark:report:android
```

Each case has a fixed warm-up count and three measured iterations. The scenario report
captures elapsed milliseconds, peak process RSS, and bounded in-memory UI responsiveness
probe counts. The report builder also fingerprints the release APK/AAB and records the
size and SHA-256 of both `libpocket_anydoc.so` and `libpocket_anydoc_jni.so` for every
packaged ABI. The schema retains the legacy field name `libraries`; on the host it contains
the canonical runner artifact, while Android entries remain the two strict native-library
names. Reports conform to `scripts/document-benchmark-report.schema.json`.

Keep host and Android reports separate. Compare typical, stress, sequential, and malicious
cases only when build type, source revision, ABI, artifact hash, and corpus hashes match.
No latency or memory claim is valid from scenario definitions, plans, debug builds, or a
single measurement; retain the validated release report as the evidence.
