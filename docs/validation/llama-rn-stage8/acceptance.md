# Stage 8.1 Android CPU acceptance

Acceptance on November 17, 2026 used isolated x86_64 release APKs with embedded bundles and 16 GiB Android emulators. The [machine-readable receipt](./android-cpu.json) records the source, artifact, native counters, and separate earlier attempts.

- Original APK source `b8f09d8335574803d6297b67f1c55b12873125dd`, tree `23cac4f5d6e02e3e802a1010971d79097833f3e3`, with a clean checkout.
- APK and installed APK SHA-256 `fc2f87a7ed311133e213dd139ed217cdf9e02e4d746d9bc3331048c1d911c737` (100,399,274 bytes), package `com.github.tah10n.pocketai.stage81.qa`.
- Android API 36, CPU with zero GPU layers, `llama.rn 0.13.0-rc.3` and native patch `68eddc2ed264a984768332eb6694385f7792dd4957c1096899368370423b7fb8`.
- Rebuilt APK for queued retrieval and CLI package verification. Source `d2bea9f21ab1f204e4c4a6b4f4a6b518db00df2d`, tree `5c4d05e76b83fa01230dda495b8f2e2c6e9420a9`, built and installed SHA-256 `9a4ecee2d0f2ecbe87ff43c765b014f5d75439fd49cd5e76d0c4a0c0918b8b3b` (100,402,974 bytes).
- Pinned [SmolLM2 and LoRA](../llama-rn-stage3/lora-fixture.json) and [E5 and BGE](../llama-rn-stage5/retrieval-fixtures.json) fixtures.

The named package was already correct in the APK. The Android scenario runner read the selected QA environment too late for the imported smoke helper to use it while recomputing build provenance. The host fix passes the current environment into the same strict package check. The existing APK was exercised with the named QA environment present at process startup and matched its original build and install digests. The rebuilt APK passed all nine CPU lifecycle steps with the QA instance supplied via the command line. The runner has separate regression coverage for the same environment.

| Check | Result | Evidence |
| --- | --- | --- |
| CPU lifecycle | Passed | All nine steps, including generation after cancellation and reload, and history isolation. |
| One slot | Passed | One running request and one queued request cancelled. The next request finished and the queue drained. |
| Two slots | Passed | Two distinct native request IDs generating simultaneously. Both requests produced 64 callbacks and their own answer markers. |
| Stop one | Passed | First request cancelled with one callback, second reached 128 callbacks and retained its own answer marker. The context drained. |
| Ordinary chat selection | Passed | Closing a comparison preserved the original answer. Choosing answer 2 replaced it with one assistant turn. Cold reopen kept the selected answer and did not resume comparison. |
| Queued retrieval with LoRA | Passed | Cancellation drained issued embedding work. The following hybrid search used queued embedding and rerank, validated indices, and restored the original A+LoRA profile after both operations. |

The 8 GiB emulator rejected the two-slot memory admission with about 239 MiB in MemFree despite higher reclaimable memory. The 16 GiB emulator passed the two-slot run with the original memory policy. One first 16 GiB single-slot attempt failed the cancellation receipt assertion and passed on a repeat with the same APK. The UI driver needed to read Android accessibility siblings and normalize the quote styles used by Markdown rendering. The original emulator data partition had too little free disk space for the first auxiliary download. A separate 16 GiB emulator with a 16 GiB data partition allowed the pinned downloads to finish. The original APK then exposed a QA error before inference. The test did not retain the parsed document source and fell back to keyword search. The updated QA keeps the source until both runs drain. It checks restoration after cancellation using the matching A+LoRA profile and a changed context identity, since cancellation suppresses the normal restoration callback.

This acceptance covers Android CPU emulators and one pinned model set. Timings in the receipt include a separate native window and total operation time, with sampled PSS and RSS. They describe the observed run. Physical device performance, Android GPU, and iOS inference are outside this acceptance.

## Reproduction

Use the named, debug-signed QA release with an embedded bundle. With the QA flags used at build time, run the lifecycle scenario on a matching installed target.

```sh
node scripts/android-scenarios.js --serial <serial> --skip-build --apk-variant release --isolated-qa-install --qa-instance stage81 --scenario runtime-inference-lifecycle --fail-on-skip
```

Open **QA parallel requests** in Chat with the pinned CPU text model loaded. Run the one-slot, timing, and individual Stop checks. Use the ordinary **Compare two answers** control to exercise closing without choosing, choosing a result, and reopening the chat. Return to QA to download the pinned auxiliary files, apply LoRA, and run queued retrieval and restoration.
