# Distribution and source

The eSpeak-enabled combined application is distributed under **GPL-3.0-or-later**.
The original MIT grant and copyright notices for project code remain in `LICENSE`;
they are not removed or replaced. eSpeak NG and the bootphon-derived frontend retain
their GPL notices. `COPYING.GPL-3.0` contains the license and warranty disclaimer.

The supported distribution route for this configuration is direct Android installation.
iOS is for development builds; this configuration does not authorize App Store distribution.

## Corresponding Source

Every conveyed APK must accompany the exact public source commit (including its source
archive/download), dependency lockfile, native patches, module source/data and build scripts.
Preserve the build provenance record so recipients can identify that commit and configuration.
Do not distribute an APK with only a moving branch URL or only a phonemizer source archive.

`modules/pocket-phonemizer/vendor/espeak-ng-source.tar.gz` is the complete pinned eSpeak NG
archive. `scripts/prepare-source.mjs` inside that module verifies and unpacks it offline and
applies the fingerprint-checked phonemizer-only dependency configuration. The full generated
data is bundled with a SHA-256 manifest; `npm run phonemizer:verify` checks the archive,
manifest, data and compiled identity. `npm run phonemizer:generate-data` rebuilds data with
a host CMake/C compiler from those same sources. Keep the previous generated data before
intentional regeneration; the script refuses to overwrite an existing data directory.

Follow `docs/android-build.md` for Android prerequisites and source builds. Install a build
signed with your own development key through `adb install`; no distributor key is needed
to build and install on an ordinary user-controlled Android device. Any distributor adding
technical installation restrictions must also supply the Installation Information required
by GPL section 6. Private signing keys and user data are not part of Corresponding Source.

## Native frontend regression checks

`npm run phonemizer:test` compiles and tests the actual mobile C++ core on the host,
including deadline/cancellation drain and injected JNI allocation failures. It also compares
the same-source engine against an independent fixed frontend corpus. It requires CMake
3.22+, a C/C++ compiler and a JDK exposed through `JAVA_HOME` (set `CMAKE` if CMake is
not on `PATH`). These checks do not substitute for Android/iOS builds or speech evaluation.

## Assets and model weights

The bundled `pocket-synthetic-en-v1` reference is newly generated from speakerless OuteTTS
speech and encoded with a pinned Apache-2.0 distill encoder. Its JSON provenance records
source/encoder hashes and licenses. No upstream Neu Jo, Dave, Greta or Juliette reference
material is bundled; the exact-version postinstall patch removes those payloads and their
embedded source maps from `llama.rn` before bundling. Old diagnostic selectors fail closed.

User-downloaded model weights retain their own terms. A conditional NeuTTS model license
is not relicensed by the application's GPL terms. Review the model license for your use.
No model weights or ONNX encoder are included in the bundled reference JSON.

Preserve upstream license notices in each dependency and in
`modules/pocket-phonemizer/vendor/`. The TTS preview exposes phonemizer license notices.
