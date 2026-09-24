# Pinned native runtime corrections

The runtime remains exactly `llama.rn 0.13.0-rc.3`. A local one-line correction clears `generated_token_probs` immediately after `ctx->completion->rewind()` in `cpp/jsi/RNLlamaJSI.cpp`, before parsing the next completion's parameters. The pinned serial completion implementation appends probability records but does not clear this vector in `rewind()`. Without the correction, repeated requests return previous requests' probability records and retain an increasing native allocation.

The existing `throwIfContextBusy` guard precedes the reset on both platforms. The app's exclusive context owner still serializes completions, tokenization, LoRA changes and teardown. This correction does not change the native token counter, sampling, parallel decoding, ABI, or any other upstream behavior.

## Installation and verification

`npm ci` runs [the local patch](../../../patches/llama-rn-0.13.0-rc.3.js) through the package's `postinstall` hook. No patching dependency is required. The patch checks the exact manifest, lockfile and installed package version, then checks all ten complete source fingerprints and build inclusion files. It accepts only the original or already-patched source. Unexpected versions or source changes fail installation; they require a fresh review rather than a best-effort patch.

Run `node patches/llama-rn-0.13.0-rc.3.js --check` to verify without writing. `npm run verify:native-config` includes this check. Fingerprints use SHA-256 after normalizing CRLF to LF:

| Input | SHA-256 |
| --- | --- |
| Original `cpp/jsi/RNLlamaJSI.cpp` | `2534ba08430259ba417e21483ebcea3cd0e01508cb40689ae7aed284212ea8c1` |
| Patched `cpp/jsi/RNLlamaJSI.cpp` | `4f4c6254c3cefecabe19110efd18dd6d70078083a88b29adf1e73ab083a667a1` |

## Native build and evidence boundary

Android's `android/src/main/CMakeLists.txt` always includes this file in `JNI_SOURCE_FILES`, linked into `librnllama_jni` and its selected variants. The iOS podspec compiles `cpp/jsi/**/*.{h,cpp}` even with its default vendored framework; source-core builds also include the file. The exact CMake, podspec and public completion-header fingerprints are checked by the patch. These two JSI corrections also work with unchanged vendor core binaries; the clock and sampler ownership corrections below additionally require building the core from source. Patching only `cpp/rn-completion.cpp` would not fix the default prebuilt-core builds.

The executable patch lives in `patches/`, which the existing Android build and prebuild provenance includes in its content fingerprints. A new native binary is required; a JavaScript bundle update cannot apply this correction. Source checks prove the installation and build inclusion contract, not device execution or an iOS build. Native acceptance must use the rebuilt APK and record its identity. The Stage 3 probability probe requires exactly one actual probability record in each repeated one-token completion, including after LoRA apply, scale change, remove and auxiliary-model restoration. The rebuilt Android CPU probe passed repeated requests, LoRA changes and auxiliary restoration with exactly one finite probability record per probe. Native iOS behavior remains `not_run` until separately built and tested.

## Checked token biases and EOS suppression

The same pinned patch corrects `cpp/jsi/JSIParams.cpp`, also compiled locally on Android and iOS. The upstream bridge clears a vector and then indexes it by token ID, which is invalid for an empty vector. The correction constructs actual `llama_logit_bias { token, bias }` entries. It requires numeric pairs, integer IDs inside the loaded vocabulary, and finite biases representable as native floats. Strings and boolean suppression values mentioned in upstream comments are not exposed by the app numeric TypeScript contract.

Duplicate user token entries use the last value, rather than accidentally adding biases. `ignore_eos` defaults to false for each request. When enabled it overrides user biases for every model EOG token (including EOS and end-of-turn tokens), using the core precomputed EOG list. Each override replaces an existing entry or appends one unique entry. This avoids relying on duplicate handling, which differs between the core sampler aligned and fallback candidate paths. Model-defined suppress tokens remain governed by the unchanged core sampler.

The original JSIParams source SHA-256 is `07a9f25b2b79bab090cfd112668f1968c6fb078e11a6d8b65c649294a4e16475`; the corrected source is `6ab84994d6db625621b501461181ad4de4d0e427ef5a960ddf2e0f7464b5c9d5`. All ten source inputs are validated before any is written. These source guards and application tests are not native behavioral acceptance; the rebuilt-device probe must independently verify suppression, bias effects and recovery after invalid token IDs.

## Fixed request clock in Jinja

The pinned core forwards `now` from `rn-llama.cpp` to `autoparser::generation_params`, but `common_chat_template_direct_apply_impl` creates its Jinja context with the wall-clock default. It never assigns the supplied timestamp. Templates using `strftime_now` therefore ignore both explicit `now` and the app's frozen request clock. A fixed 2023 test timestamp was rejected by the template guard on the 2026 Android QA run; that APK did not pass the template/prefill acceptance scenario.

The correction adds exactly `ctx.current_time = std::chrono::system_clock::to_time_t(inputs.now);` immediately after constructing the context in `cpp/common/chat.cpp`. Nested contexts already inherit `current_time`. Existing native local-time formatting remains unchanged; the patch does not change timezone semantics. Both explicit and automatically frozen request timestamps now use the same value throughout formatting.

Original `cpp/common/chat.cpp` SHA-256: `a7e0aeaf40a7f9ac94093c2554d1086d430cade04a6a03e0001b711643338e34`. Corrected SHA-256: `2184f18ae06502e17060e1bcbbccd0faa12416d8ecbc129e1f0b503e014d66f5`. The patch also fingerprints the Jinja clock consumer, context inheritance, request types, bridge clock forwarding, and Android core-source inclusion. It preflights every source before writes and accepts an earlier installation with the two bridge corrections already applied.

This function belongs to the prebuilt core, so changing the source file alone does not fix a default vendor binary. Android must use `rnllamaBuildFromSource=true`; iOS must set `RNLLAMA_BUILD_FROM_SOURCE=1` before CocoaPods evaluates the podspec. These are upstream switches in the same pinned rc.3, with no toolchain or dependency update. `plugins/withLlamaSourceBuild.js` sets these switches during Expo prebuild; native configuration verification rejects missing or conflicting generated settings. The Android build wrapper also rejects external Gradle overrides of the source-build property. An isolated x86_64 CPU QA build can limit `reactNativeArchitectures=x86_64` and `rnllamaVariants=rnllama,rnllama_x86_64` to avoid compiling unrelated CPU-feature variants; this does not establish other-backend coverage.

The [rebuilt Android CPU acceptance](../../llama-rn-013-stage3-acceptance.md) passed the fixed-clock template, exact count and prefill (16 evaluated tokens each), and all three regression packs. Source checks alone do not establish this result. iOS remains `not_run` until separately built and tested.

## Sampler ownership after initialization failure

The source-core Android acceptance run aborted in `llama_rn_context_completion::initSampling` after an invalid grammar request. The pinned function frees the previous `ctx_sampling` before calling `common_sampler_init`. If initialization throws, the assignment never happens and the context retains the freed pointer. The following completion or context teardown can free it again. The correction resets `ctx_sampling` to null immediately after releasing it, before calling the potentially throwing initializer.

The initializer also allocates its chain before rejecting malformed grammar and can throw after allocating the grammar or reasoning-budget sampler. A local ownership guard now frees those objects and any pending chain samplers during exception unwinding. Successful chain insertion clears the corresponding pending pointer; successful aggregate construction transfers all ownership to `common_sampler` and disables the guard. Reserving the pending vector before sampler factory calls avoids losing a freshly returned sampler to vector growth. Sampler order, grammar restrictions and successful-result ownership remain unchanged. The same initialization path previously logged the complete grammar and generation prefill on failure, and token IDs/pieces in debug messages. These four diagnostics now contain static categories only, without grammar, prompt or token payloads; exception behavior is preserved.

| Input | SHA-256 |
| --- | --- |
| Original `cpp/rn-completion.cpp` | `4563b4a65e98e7022d4ae38014f12acd2241a0911fc2201f5da465679df82087` |
| Patched `cpp/rn-completion.cpp` | `e4148aee26b8f99b8646407e3b217157ef66a3614e0529dcc2cf6fe0416d2b2d` |
| Original `cpp/common/sampling.cpp` | `e4926ff1507748facc785d6192554f66dcbaa7aa98b3371d907b11414c1f9fa5` |
| Patched `cpp/common/sampling.cpp` | `942c2c508a03968f8ba78fc554832c899b0fc8e29be4f6c526ba8118f141cf1c` |

Full-source fingerprints additionally pin the sampler free/chain insertion contracts and sampling declarations. All ten patch sources are preflighted before any write, including installations with the previous three corrections already applied. Tests check the real patched ownership and transfer sites, idempotence and rejection of source drift; these are source-contract checks, not native execution. The earlier crashing APK remains a failed run. The [new source-core APK acceptance](../../llama-rn-013-stage3-acceptance.md) passed invalid grammar rejection followed by ordinary generation, later context replacement and all three regression packs. This independently verifies recovery on Android CPU; it does not establish other-platform behavior.

## Grammar parser and lazy-trigger diagnostic privacy

The sixth source correction replaces the grammar parser error diagnostic with a static category. Neither the complete grammar nor the exception text is logged: parser exceptions can include rule identifiers or unparsed input. Three lazy-trigger debug messages likewise omit token IDs, token pieces and constrained content. The debug-only content copy is removed; trigger matching, parser failure handling and the explicit `print(FILE*)` utility are unchanged.

Original `cpp/llama-grammar.cpp` SHA-256: `7f1d1912560a81254674f713cd82da1872c4a83ebf1eca80ae90558373283939`. Corrected SHA-256: `b14101f01415a702662ee9a746f0831ee14518e3c7f3796aa42ab810f5f17d33`. This core correction requires the same source-build switches and rebuilt native acceptance as the ownership fix. Installation tests verify these exact logging sites and reject drift in the sixth source before writing any earlier source.

The formatter core also uses static error categories instead of template exception text, parser dumps, generation prefill, full or unparsed model output, complete parsed messages, and tool payloads/names. The original clock-only patched `common/chat.cpp` fingerprint (`ad51d8e0db5e98d2f5ae3c7aa56ad6c82664cb00204d3c4a5b74b4b8df743c24`) is explicitly accepted as one migration state; only the reviewed privacy replacements are applied to it. All other unknown source fingerprints still fail closed. The explicit AST debug print utility and commented diagnostics remain unchanged.

## iOS source-build header ownership

The seventh guarded correction narrows iOS sources to the package root and compiles C/C++/Objective-C/assembly files without exporting internal C++ headers. Internal headers remain preserved on disk; explicit JSON, CPU, codec and mtmd search paths resolve the source-build includes without relying on flattened header maps. Existing exclusions, Metal assembly inputs, backend flags and the prebuilt-framework branch are unchanged. This prevents CocoaPods from copying bundled XCFramework headers and flattening unrelated `common.h` files into the same framework output.

Original podspec SHA-256: `af42dc7cca2823272b4367ddfd21b8191bb265d8fd5c54b6a2072959b0931a55`. Corrected SHA-256: `e539fba083a63e6edda56d27780c7d14194542cabb3b99919a4fe81a609adbff`. The first iOS compile attempt failed with duplicate header output commands before compilation. Source-contract tests cover the corrected inclusion boundary; they do not establish a successful iOS build or inference.

## Jinja JSON header resolution

The two Jinja translation units that import the common JSON API now use `../json.h`; the JSI source branch uses `../common/json.h` and preserves the prebuilt-framework imports. Bare `json.h` is ambiguous under dependency header maps. The failed build found a header but not `common_json`; the log does not identify the competing header. Relative imports preserve the intended header on Android and iOS. The preceding iOS attempt reached C++ compilation and failed at this unresolved type; it is not successful iOS acceptance.

- `cpp/common/jinja/value.cpp`: original SHA-256 `9e9ee66217afe97e555f9423be6152fd69f8c1776740f002a9cd12681a76a411`; corrected `48c3eaad040ccdc3cbc278b5648aa79a25ae83656a483f56269470a5ded5f22f`.
- `cpp/common/jinja/caps.cpp`: original SHA-256 `cc497360610e81359fa843656fa8352a917dd37926737cfc9d888cf6f7d1baa0`; corrected `329b9a013dba2d19f974a4af1e8733c0c91de1dfa942bf733aae9f7ad7b6bfe1`.
- `cpp/jsi/JSINativeHeaders.h`: original SHA-256 `100fe22ecc52e4979d370cfb62986a2fd2b0abe6b9b98cf594610b9dad94e053`; corrected `2a79c573ef863ed015ed35413ee44618486aa714fbafd2324913f7000fc7659d`.

## Quoted headers before dependency header maps

The iOS source-build pod adds `-iquote` for the same explicit runtime header directories, in their existing order, before ordinary dependency header maps. Local headers retain precedence; angle/framework imports and prebuilt mode are unchanged. This fixes the confirmed `rn-slot.h` to Reanimated `common.h` collision without exporting internal headers. The patch also accepts the exact prior corrected podspec fingerprint when upgrading an existing installation.

A small Clang 18.0.2 preprocessing fixture reproduced a conflicting header map with paths containing spaces: ordinary `-I` lookup selected the wrong header and failed; the same command with `-iquote` selected the intended runtime header and passed. This checks compiler search semantics, not Xcode application compilation or iOS inference. See [Clang's quote search group](https://clang.llvm.org/doxygen/HeaderSearchOptions_8h_source.html) and [the `-iquote` option](https://clang.llvm.org/docs/ClangCommandLineReference.html#cmdoption-clang-iquote).
