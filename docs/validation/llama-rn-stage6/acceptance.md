# Stage 6 local speech acceptance

This report retains the 2026-10-02 source/APK identities below. The later initial-Play fix and its new binary are documented separately in [Playback admission acceptance](playback-admission.md).

On the fresh source/APK below, **both token and continuous synthesis, decode, playback, lifecycle and new independent ASR content passed**. Implementation-source CI, including the iOS simulator build, passed. Five independent native baselines on that unchanged APK passed; raw failed attempts retain their status. Fresh four-device-file hashes and ordinary no-A synthesis/background clear passed. The separate no-A clip has no content acceptance.

See [usage](../../local-tts.md), [fixtures](tts-fixtures.json) and [sources](model-sources.md). File/admission, native, playback and content results are separate.

## Source and build identity

Draft PR [#185](https://github.com/Tah10n/pocket-ai/pull/185), `feat/local-tts-playback`, depends on [#183](https://github.com/Tah10n/pocket-ai/pull/183). Its base is `feat/semantic-document-retrieval`, accepted Stage 5 head `c8a2f0badb11a126da2b99c6a19fc1a23bc6851a`. Stage 6 remains separate and Draft.

| Fresh build field | Record |
| --- | --- |
| Published implementation source | `52cb410b649d7d1372e0ad99a4c631244fd41b54` |
| Clean-input provenance digest | `605a5086438c94e08614b67654579777f895701da8e1298aad9ff87205db9046` |
| APK SHA-256 / bytes | `49a735e28278afffab50b143330b261db9500433e02c67898fa9771ffe45fa8e` / 88,984,014 |
| Install / binary scope | `com.github.tah10n.pocketai.qa`, release, x86_64 CPU; installation completed 2026-10-02 10:58:42 UTC; installed full-hash readback matched the APK and digest |
| Runtime device | `sdk_gphone64_x86_64`; actual SDK 36 / Android 16 readback, Android 36.1 system image |
| Fresh native build | Passed in 11m 55s; rn-tts.cpp and `:expo-audio:compileReleaseKotlin` compiled |
| Release bundle/native libraries | Hermes bundle SHA-256 `8bf93569e1ae5850df53eef6594861a849d330b23e252471f0a643fb1e59de61`; 33 x86_64 libraries; RN 0.83.10 library matched its release AAR |
| Generated recording/background permissions and audio foreground service | No recording/audio-background permissions or audio foreground service; existing data-sync service remains |
| llama.rn source-patch SHA-256 | `ba414bf20cf41297c1f96252cd5d73cb6a18e9e59e1efe1138297204ce819a52` |
| expo-audio `55.0.18` source-patch SHA-256 | `4a230a26433b54b01faa54cd4a7fb208b7cca9e912df162d73529f195f131775` |


QA debuggability enables private fixture access with release JS/libraries. Seven measured expo-audio files matched the pinned script map (2 TS / 2 Android / 3 Swift); they are not direct provenance entries. Source-build/autolinking, fresh Kotlin/Java/JAR compilation, DEX registration and player contracts jointly support patched Android linkage. Android readback SHA-256: `df869cb2d04a86e011c18348875ee2e84c22f64d07a9acb320ea6b4ea75d67cb`.

## Exact profiles, API and bounds

All four existing device files matched full hashes/sizes at 2026-10-02 12:12:26.324 UTC (2,332,060,864 bytes; same source/APK/digest, QA app stopped, files unchanged/no download). Receipt SHA-256: `db5d841317129a3a29b8a6d29ce19a5f933589647d1446f4ccd85a552c88b18d`. Per-pair service validation passed before init. Other variants/languages inherit no acceptance; notices: [manifest](tts-fixtures.json).

| File | Revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| OuteAI OuteTTS 1.0 0.6B Q4_K_M | `7e8de3b4d95e100812fd7e6f4372510d0830a798` | 401,741,952 | `a0e2afa131b8a5029de0c653d55b71aab99744226234fcf1d80c55dade21020b` |
| BricksDisplay DAC speech F16 | `4cd6ecf17367ebc03bba4b2ce8186268a6ce7436` | 147,786,400 | `f58e57eabef8d574f4d08828f0116d93341bd91a26413390b780c6f1e8491337` |
| BricksDisplay BlueMagpie Barbet 1B Q4_K_M | `1f195f06506314c1de4a4d35cad2e77b28cfe7db` | 693,008,608 | `5bfa46f44936cad36eaf670da4b7a162c5d5ab44cf75827d1c09e78a03d82bde` |
| BricksDisplay BlueMagpie AudioVAE Q8_0 | `1f195f06506314c1de4a4d35cad2e77b28cfe7db` | 1,089,523,904 | `7b4c9ac08723984616e5d132ebcf99f57fec2d8aff181c24bb351a72943930f1` |

Both profiles use context 4,096, batch 512 / microbatch 128, four CPU threads / zero GPU layers, `embedding: true`, normalize -1, pooling none, shifting off, mmap on / mlock off. Codec batch is 512 / GPU off. Speaker is omitted; these exact profiles need no reference audio or phonemizer. One heavy context owns A → TTS/codec → A; parallel stays off, `n_parallel: 1`, cache budget 0 / checkpoints 8.

Seed is 42. OuteTTS uses temperature 0.4 / top-k 40 / top-p 0.9 / min-p 0.05 / repeat penalty 1.1; continuous uses 1 / 40 / 0.9 / 0 / 1, with native CFM fixed at CFG 2.8 / nine timesteps independently. Chat tools, JSON/GBNF, LoRA, prefill, stops and sampling are not inherited.

| Flow / selected language | Generation and decoder bounds | Admission reserve |
| --- | --- | --- |
| `tokens` / English (`en`) | 2,304 generation steps; 1,200 frames × two codebooks, at most 2,400 codes; mono 24 kHz / 384,000 samples | 3,441,568,640 bytes |
| `continuous_embd` / Taiwanese Mandarin (`zh-tw`) | 100 steps × four frames; 64 values/frame, at most 25,600 latent elements; mono 48 kHz / 768,000 samples | 9,066,120,384 bytes |

Shared limits: 240 characters, 512 prompt tokens, 16 seconds, one 16-bit mono cache WAV (44-byte header; ≤1,536,044 bytes), no queue. Frames × actual hop are bounded before decoder graphs; finite PCM is checked afterward. Generation limits reject partial success. Latents are not retrieval-normalized.

Formatting/completion/Stop, both final-payload decoders, actual rate and vocoder release are integrated; deprecated wrapper is unused. Speaker omission differs from default; phoneme prerequisites fail closed. Exact [API contracts](../../llama-rn-capabilities.md#tts-and-speaker-contracts).

OuteTTS/DAC: Apache-2.0/CDLA-Permissive-2.0. BlueMagpie's conflicting conversion/base labels are resolved conservatively to local research/evaluation; weights and generated speech are not published.

## Fresh native, playback and content results

| Current-source scenario | Tokens / English | Continuous / Mandarin |
| --- | --- | --- |
| CPU init, capabilities, natural EOS; three finite PCM/rate/bounded-WAV results | `passed` | `passed` |
| Native playback and rendered Play/Pause/Stop/Replay | `passed` | `passed` |
| Stop → confirmed drain → retry; repeated context/codec release/reload | `passed` | `passed` |
| A + ordered LoRA → TTS/codec → A → real chat response | `passed` | `passed` |
| Used-codec deletion refusal; unchanged chat; final/cold clip deletion, no autoplay | `passed` | `passed` |
| New independent local ASR and separate content review | `passed`; 20 words / 0 edits | `passed`; character edits 0/2/1, reviewed equivalents |
| Host exported clips removed after review | `passed`; all three full hashes verified | `passed`; all three full hashes verified |

Both six-step flows completed without force-stop: tokens 238/472/468 codes, continuous 5,120/4,864/5,632 latent elements. Public controls used 188,792 samples/24 kHz and 353,280/48 kHz. All five captures per flow passed review; machine positions prove Pause/resume. Replay reused clips; cold restart deleted them with no autoplay.

### Independent fresh content evidence

New ASR ran on fresh exports; their deterministic full hashes equal older clips, but old recognition was not reused. English 5/7/8 words matched in order with no omissions, substitutions, additions, early-stop indications or confidence warnings. Listening was `not_run`.

| Input / actual ASR transcript (raw exact match) | Words / edits | Samples / Hz / seconds | WAV SHA-256 |
| --- | --- | --- | --- |
| The blue door is open. | 5 / 0 | 38,072 / 24,000 / 1.586333 | `4cfadc789c51f5a50b317494ca2fb34f4e991e4fff2cc62e00fead39d34825cd` |
| Please read this sentence clearly, then stop. | 7 / 0 | 75,512 / 24,000 / 3.146333 | `43098b50ce73816e458b32c38ceda2d1882706d3c18152e0c2fab07362129e73` |
| Tomorrow morning we will visit the quiet library. | 8 / 0 | 74,872 / 24,000 / 3.119667 | `930e4c4dcb4c88f2768782fd7438d19ecd414dd99ced4d9ed943cf9273fa7509` |

| Mandarin expected input → actual ASR transcript | Characters / edits | Samples / Hz / seconds | WAV SHA-256 |
| --- | --- | --- | --- |
| 今天的天空很藍，我們一起去公園散步。 → 今天的天空很藍我們一起去公園散步 | 16 / 0 | 153,600 / 48,000 / 3.20 | `e65236cd4debd0300c1deab02ac248da3e9377d624255a97b9d856e5b8cacb27` |
| 請把這段文字清楚地念出來，然後停止播放。 → 請把這段文字清楚的唸出來然後停止播放 | 18 / 2 | 145,920 / 48,000 / 3.04 | `76b696c708a642371e48f46b0c1ee09ad18d95bb1a7d2411e0a8dd7259b2f44d` |
| 明天早上八點，我會帶著一本書去圖書館。 → 明天早上8點 我會帶著一本書去圖書館 | 17 / 1 | 168,960 / 48,000 / 3.52 | `6a1ff6e9337144e70c42cae49e0e51e5065095992d5191a65cfdf9a78373c5eb` |

Character counts use the declared normalization. Separate review preserved 0/2/1 edits and accepted punctuation, 地/的 (spoken de), 念/唸 (reading verb nian) and 八/8 (eight); all clauses remain in order without omission/addition. This noisy ASR evidence does not certify accent, pronunciation or general quality.

Offline ASR: `Systran/faster-whisper-small` (MIT), revision `536b0662742c02347bc0e980a01041f333bce120`, model.bin SHA-256 `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`; faster-whisper 1.2.1 / CTranslate2 4.8.2 / PyAV 16.1.0. CPU int8, four threads / one worker, beam 5 / best-of 1 / temperature 0 / max 128 tokens. Forced en/zh is not language detection. No prompt/prefix/hotwords/previous-text conditioning/VAD; normalization is NFKC, case, punctuation and whitespace only, without script conversion.

| Compact fresh evidence | SHA-256 |
| --- | --- |
| Token native receipt | `225920654815589a95a2d6eb479d959ab5f2264a52749a938104d12ff12ebb74` |
| Token host scenario report | `e598e4cc1bd6df771ca4dc2c9f011ec6a4d3280c08638e7be14b114116c3bcdb` |
| Token immutable native/UI archive manifest | `ce4edbdb74cef9f87da548144fafb89e3d8ebc3f0f681b4b986095a7bb932fe9` |
| New token ASR result | `56cc6b93375719514a3023875ba3fff74ff44b80580b3ddcc0aef0c23d00f3dd` |
| Separate accepted token content review | `215fd1ea0d38783f3c6f314047fbe18db1c09fc620ef9ebcaf6d9db2afdc4ca3` |
| Continuous native receipt | `74b1be3d3c2a0a36574c8d2e8f4aad2c7587d5f144267cdc6160d7d268438e83` |
| Continuous host scenario report | `2d033bd069359541fb0ab7205dff18b400df5ea31f5a6daa64feab075d120186` |
| Continuous immutable native/UI archive manifest | `9d9e0c9e9aa5ee7ec9a4d4024694ce1a0c49dbeb7d72f8948b1454a01dba02e3` |
| New continuous ASR result | `0e7702963bfaf64a8e117bf6c9e7ff514fdee2d0d8d9f9e81b8036bf5ab0622d` |
| Separate accepted continuous content review | `750cfcdcdd75b8dbe2285333d68a7cc8b02f53b42d18e0a84960608ab43de92a` |

Native `contentVerification: not_run` and ASR `human_review_pending` stay immutable; separate accepted reviews join receipt/WAV hashes. PCM/player motion do not prove words or listening.

## Fresh ordinary no-A and background

On the current source/APK/digest, ordinary Models controls selected the OuteTTS role and exact installed DAC codec without a download. Home/new empty chat showed no loaded A and disabled Send before and after synthesis. The exact 114-character preview produced 170,232 mono samples at 24 kHz (7.093 s), a 340,508-byte WAV, SHA-256 `01a470d4fb80e1d62c656dfb421564675e234122d42ec0b2d65d6e95091f88bb`.

Play/Pause/Stop/Replay passed: initial natural EOF, then paused positions 0.970/1.936/0.777 s. Ten actual captures were reviewed, including Playing → Android Home/Launcher → return. Return closed the modal, cleared phase/cache, removed the private clip and did not autoplay. Visible message/body and tool-fixture markers stayed unchanged; full persisted-history proof is separate native-core evidence. This clip's independent content/listening is `not_run`; the six fixed ASR exports remain separate.

Accepted at 2026-10-02 12:30:21.6035433 UTC. Raw receipt SHA-256: `76d01b93f500d8d7fea7ac3885b7782c01d273519d60fdd47fd0e14f54c7ab33`; separate review: `893eb0b1fc56c9ddc856cd0632e7188c7f1021f0e51ab2dc4c288dab051d0814`. Earlier QA preparation/transport failures occurred before synthesis and remain preserved; no product/native failure is attributed to them.

## Historical memory attempts and ordinary UI

Historical scope: source `9d6aa9dc797a25226e3d18c1442fefc6ddd00b8c`, digest `80bb42576695d86c561edac537f75456789b798ebbf88b5d957388073c9acf91`, APK `451530bf382dfdd461a6b04e19959dc8943e0964125a96cf6d47e3c744ee5ffc` (88,983,970 bytes).

The historical 16 GiB continuous attempt failed `memory_insufficient` before init: cleanup only, no exports or synthesis/decode/content. Admission-time memory was not retained; no OOM/codec-defect/cache-causation claim follows. A distinct same-userdata 32 GiB retry passed protocol/lifecycle and ASR review (edits 0/2/1) without weakening admission; listening was `not_run`.

These six ordinary cases retain that historical APK. The new source changes fatal async cleanup classification/deferred regressions; these ordinary receipts are not relabelled.

| Ordinary case | Actual observation |
| --- | --- |
| Real completed-answer Speak | Exact plain editable preview, synthesis and rendered controls passed; its full WAV joined to independently accepted English content |
| EN review / RU review | Initially empty standalone preview and exact JSON/code/table drafts; Synthesize disabled before acknowledgement and enabled after. No structured-input synthesis/content claim |
| EN overlength / RU overlength | All 241 **entered** characters preserved; Synthesize disabled. Input used acknowledged 24-character ADB chunks, not a clipboard-paste test |
| No loaded chat A / background | 114-character English input produced 170,232 samples at 24 kHz; controls passed, A remained unloaded before/after. This separate clip's content was `not_run`. Actual playback motion preceded background; clip deleted on return with no autoplay |

Visible message/body IDs and tool marker survived Close; clips were deleted. Full history is separate core evidence, whole-draft unit input/paste coverage separate from chunked device entry. Failed automation/unreached steps remain failed/`not_run`.

## Memory, privacy and storage limits

Low-confidence reserves include weights/duplicate codec/dequantization, graphs, KV/hidden, bridge arrays and WAV/player copies; they are not measured peaks or fit guarantees. Before init, after A suspension/file checks, Android caps available-minus-threshold by MemFree, rejects lowMemory and grants no cache credit.

Fresh boot used CLI 32,768 MiB over unchanged stored 16,384 MiB: MemTotal 32,866,116 / MemFree 30,534,092 / MemAvailable 31,553,044 / SwapTotal 24,649,580 KiB. Boot is not admission time; historical zero-swap state is distinct. Five-second samples: tokens 24 observations / 1,957,904,384-byte max RSS / 1,958,952,960-byte lifetime HWM; continuous 73 / 3,959,287,808 / 4,007,833,600. Sampled maxima are lower bounds on the peak; HWM covers process lifetime. Neither is an exact decoder or flow-specific peak. Decoder bounds are separate.

Fresh token log review: finite 106,214 bytes / 674 lines, SHA-256 `b0d0e31af47d34eb90612342c9daeeb16ebc6173b19689031d450db166667164`; zero targeted text/prompt/code/latent/PCM/model-cache matches, two geometry candidates / four HTP startup library-path diagnostics. Controls: 26/26 in-memory checks, no Android canary injection. Fresh continuous log review is `not_run`: the owned emulator tree exited after terminal native/public acceptance and before UID-only collect; ADB returned 1 and no raw dump was produced. Host exit cause is unknown and is not attributed to product/native TTS. Finite rotating buffers do not prove universal absence. Separate privacy-review SHA-256: `a308a3e0e7ecef5d2b522998f1650e491bac241cd31b2e03624c9d4a001e7fe2`.

Stop interrupts completion and waits. Init/decode/release lack public cancellation; late playback is invalidated while calls drain. Timeout keeps leases; uncertain release/deletion blocks reuse, including fatal async `release_failed`/`storage_failed`. Dispose player → release shared object → delete file. The sole private-cache WAV is unencrypted/ephemeral, absent from history. All six fresh host exports were full-hash verified and deleted after review.

## Checks and unverified cases

| Check / case | Status |
| --- | --- |
| Focused async cleanup regressions | 51 tests passed, including two deferred race regressions |
| `npm run verify:release` on published source | Passed: 280 Jest suites / 6,298 tests, typecheck, lint, AnyDoc and native config |
| Fresh runtime/resource/Stage 3/local-tool/Stage 5 baselines | Five independent same-APK native cases passed; scope and retained failures below |
| Hosted CI of implementation source `52cb410b649d7d1372e0ad99a4c631244fd41b54` | [passed](https://github.com/Tah10n/pocket-ai/actions/runs/36995091671): deterministic, Android native release API 32–35 and aggregate verify; optional Android QA skipped |
| Hosted iOS build of implementation source | [passed unsigned simulator build](https://github.com/Tah10n/pocket-ai/actions/runs/36995091671/job/110801738683); hosted CI, separate from execution |
| Fresh no-A synthesis/background clear | `passed`; separate 114-character clip content `not_run` |
| iOS synthesis/decode/playback/content | `not_run`; no iOS execution |
| Physical focus/headphone/Bluetooth route tests | `not_run`; no physical route exercised |
| Native injected init/decode/release/uncertain-drain failures and stale-change matrix | `not_run` beyond individually recorded observations; deferred application ownership/error tests are separate |
| Actual listening, Russian speech, GPU/NPU TTS and wider model/language support | `not_run`; exact CPU/input scope only |

Five independent same-APK review SHA-256: `23b9eba42bcedf0a8ed74690f12e658882e856e3be635e37e9f2962631a67b71`. Stages 1–4 passed together, including tool cold history/no reexecution and four recovery cases; automatic calculator selection stayed false. Separate Stage 5 retry passed eight quota-failure/restoration/Stop/cold/cleanup steps (report `a52913fb5e4b9a1749f6281eb26d09c3cd4cf46abe4f59bdd4c15bcf41a5966e`). After-Stop/next-query `answerMatched: false` remains; only lifecycle is accepted there.

The raw five-case pack stays failed (`2ec378ce35349581a7ca7880d58480592a3739c5344454b2d1f2e555334f0ab2`): Stage 5 `answer_match`, cause unknown. Earlier Stage 4 cold validation found two synthetic QA threads where one was required; an isolated retry lacked process-local Stage 3 proof (all native steps `not_run`). After deleting exactly those two QA chats with Home confirmations, the same APK passed core/recovery/cold checks. Other chats/models/data and all failed records were preserved; no product history defect is inferred.

Stage 1–5 original receipts retain scope; unchanged ranking does not repeat/relabel the 36-case quality matrix. Final report-head equality/CI is attached to the PR separately from this implementation-source APK.

Reference audio/microphone/speaker lifecycle remains Stage 7; no merge, Ready, release or deploy.
