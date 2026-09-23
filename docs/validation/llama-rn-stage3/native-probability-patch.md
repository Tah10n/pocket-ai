# Pinned native bridge corrections

The runtime remains exactly `llama.rn 0.13.0-rc.3`. A local one-line correction clears `generated_token_probs` immediately after `ctx->completion->rewind()` in `cpp/jsi/RNLlamaJSI.cpp`, before parsing the next completion's parameters. The pinned serial completion implementation appends probability records but does not clear this vector in `rewind()`. Without the correction, repeated requests return previous requests' probability records and retain an increasing native allocation.

The existing `throwIfContextBusy` guard precedes the reset on both platforms. The app's exclusive context owner still serializes completions, tokenization, LoRA changes and teardown. This correction does not change the native token counter, sampling, parallel decoding, ABI, or any other upstream behavior.

## Installation and verification

`npm ci` runs [the local patch](../../../patches/llama-rn-0.13.0-rc.3.js) through the package's `postinstall` hook. No patching dependency is required. The patch checks the exact manifest, lockfile and installed package version, then checks both complete source fingerprints and build inclusion files. It accepts only the original or already-patched source. Unexpected versions or source changes fail installation; they require a fresh review rather than a best-effort patch.

Run `node patches/llama-rn-0.13.0-rc.3.js --check` to verify without writing. `npm run verify:native-config` includes this check. Fingerprints use SHA-256 after normalizing CRLF to LF:

| Input | SHA-256 |
| --- | --- |
| Original `cpp/jsi/RNLlamaJSI.cpp` | `2534ba08430259ba417e21483ebcea3cd0e01508cb40689ae7aed284212ea8c1` |
| Patched `cpp/jsi/RNLlamaJSI.cpp` | `4f4c6254c3cefecabe19110efd18dd6d70078083a88b29adf1e73ab083a667a1` |

## Native build and evidence boundary

Android's `android/src/main/CMakeLists.txt` always includes this file in `JNI_SOURCE_FILES`, linked into `librnllama_jni` and its selected variants. The iOS podspec compiles `cpp/jsi/**/*.{h,cpp}` even with its default vendored framework; source-core builds also include the file. The exact CMake, podspec and public completion-header fingerprints are checked by the patch. Default vendor core binaries remain unchanged. Patching only `cpp/rn-completion.cpp` would not fix the default prebuilt-core builds.

The executable patch lives in `patches/`, which the existing Android build and prebuild provenance includes in its content fingerprints. A new native binary is required; a JavaScript bundle update cannot apply this correction. Source checks prove the installation and build inclusion contract, not device execution or an iOS build. Native acceptance must use the rebuilt APK and record its identity. The Stage 3 probability probe requires exactly one actual probability record in each repeated one-token completion, including after LoRA apply, scale change, remove and auxiliary-model restoration. Native iOS behavior remains `not_run` until separately built and tested.

## Checked token biases and EOS suppression

The same pinned patch corrects `cpp/jsi/JSIParams.cpp`, also compiled locally on Android and iOS. The upstream bridge clears a vector and then indexes it by token ID, which is invalid for an empty vector. The correction constructs actual `llama_logit_bias { token, bias }` entries. It requires numeric pairs, integer IDs inside the loaded vocabulary, and finite biases representable as native floats. Strings and boolean suppression values mentioned in upstream comments are not exposed by the app numeric TypeScript contract.

Duplicate user token entries use the last value, rather than accidentally adding biases. `ignore_eos` defaults to false for each request. When enabled it overrides user biases for every model EOG token (including EOS and end-of-turn tokens), using the core precomputed EOG list. Each override replaces an existing entry or appends one unique entry. This avoids relying on duplicate handling, which differs between the core sampler aligned and fallback candidate paths. Model-defined suppress tokens remain governed by the unchanged core sampler.

The original JSIParams source SHA-256 is `07a9f25b2b79bab090cfd112668f1968c6fb078e11a6d8b65c649294a4e16475`; the corrected source is `6ab84994d6db625621b501461181ad4de4d0e427ef5a960ddf2e0f7464b5c9d5`. Both source inputs are validated before either is written. These source guards and application tests are not native behavioral acceptance; the rebuilt-device probe must independently verify suppression, bias effects and recovery after invalid token IDs.
