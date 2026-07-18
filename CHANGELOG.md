# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: This file is maintained automatically by Release Please based on Conventional Commits (PR titles).
> Avoid editing it manually unless you are bootstrapping or fixing the release history.

## [1.6.0](https://github.com/Tah10n/pocket-ai/compare/v1.5.0...v1.6.0) (2026-07-17)


### Features

* add guarded MTP speculative decoding ([#129](https://github.com/Tah10n/pocket-ai/issues/129)) ([d0f7a0e](https://github.com/Tah10n/pocket-ai/commit/d0f7a0ead009683dba737e5298d4fbd48c197b67))
* **multimodal:** add local attachment pipeline ([#119](https://github.com/Tah10n/pocket-ai/issues/119)) ([17ebd17](https://github.com/Tah10n/pocket-ai/commit/17ebd172942897b2d0e692c0fc2f4a5a5589071c))


### Bug Fixes

* harden model parameters sheet layout ([4c568da](https://github.com/Tah10n/pocket-ai/commit/4c568da0cf9ca53acf59558104fa3d0c63786d0f))
* harden multimodal readiness and catalog loading ([#121](https://github.com/Tah10n/pocket-ai/issues/121)) ([26e0b3b](https://github.com/Tah10n/pocket-ai/commit/26e0b3b8710dc17e64865d7547049507cf82d8aa))

## [1.5.0](https://github.com/Tah10n/pocket-ai/compare/v1.4.0...v1.5.0) (2026-05-24)


### Features

* add catalog variant picker ([92a0d95](https://github.com/Tah10n/pocket-ai/commit/92a0d95b2205e7ee5e73908120d59dcca657fc3d))


### Bug Fixes

* **chat:** add indexed thread commit markers ([8d3bacc](https://github.com/Tah10n/pocket-ai/commit/8d3baccfbf4aa4846f381590b440ff00e98a0470))
* **chat:** mark persistence imports as type-only ([f8d7aae](https://github.com/Tah10n/pocket-ai/commit/f8d7aae96aa7dc3d07d03f87647b11c0b8b56906))
* **download:** defer unsafe cancel cleanup ([5460b81](https://github.com/Tah10n/pocket-ai/commit/5460b81e89d2e7c90a3c25837231f3d6fc5db61b))
* **download:** harden cancel cleanup and GGUF integrity state ([#99](https://github.com/Tah10n/pocket-ai/issues/99)) ([59e6f03](https://github.com/Tah10n/pocket-ai/commit/59e6f030354936f9c3a50cf821db27b8c4d0b225))
* **download:** validate cancel cleanup and GGUF payloads ([f0e758d](https://github.com/Tah10n/pocket-ai/commit/f0e758dc7498153e0fe1ce684452e5edea8d982f))
* **engine:** evaluate intermediate safe load profiles ([3ca4df5](https://github.com/Tah10n/pocket-ai/commit/3ca4df5eeea82a70efdf830549329e0433acada3))
* **engine:** harden template stop resolution ([94ad6fa](https://github.com/Tah10n/pocket-ai/commit/94ad6fa4b687e4c73ddaad8b03fc14a454191bcf))
* **engine:** harden template stop resolution ([0972df5](https://github.com/Tah10n/pocket-ai/commit/0972df5f5d443af64aa15013c0ead26c9903e3a0))
* **engine:** preserve backend init retry diagnostics ([d97d9e4](https://github.com/Tah10n/pocket-ai/commit/d97d9e4e31d2b55944879254a723be1db2236e06))
* **engine:** probe first-run GPU profiles conservatively ([06c700d](https://github.com/Tah10n/pocket-ai/commit/06c700d611d8a4f70473df8a79b9b30d5e22b33f))
* finalize catalog variant follow-ups ([06f2abd](https://github.com/Tah10n/pocket-ai/commit/06f2abd323282bee0888b677add998c30e8b1d4a))
* harden catalog cache variant identities ([b759a3a](https://github.com/Tah10n/pocket-ai/commit/b759a3a59b9c757f418095614aadd05c8740abc0))
* harden catalog variant filtering ([9ffa572](https://github.com/Tah10n/pocket-ai/commit/9ffa57237486351024896c45929a10c4a7f262ac))
* harden catalog variant picker follow-ups ([9f0bfec](https://github.com/Tah10n/pocket-ai/commit/9f0bfec71727f420ef835073f2ca465c27165501))
* **integrity:** harden SHA-backed GGUF validation ([5919c78](https://github.com/Tah10n/pocket-ai/commit/5919c78d3538797ffa79444e4a947d0d30ab3e91))
* **integrity:** reset legacy local file changes ([d148c09](https://github.com/Tah10n/pocket-ai/commit/d148c0947052e2a20e0f39ff6dc3b58a56efd947))
* **integrity:** reset stale local model state ([6e206db](https://github.com/Tah10n/pocket-ai/commit/6e206db280caec59baec1e49ec6b76e56d842c8e))


### Performance Improvements

* **chat:** adapt streaming UI patch cadence ([44677d3](https://github.com/Tah10n/pocket-ai/commit/44677d3d504bc04d236e253570cdfe56dca11d1c))

## [1.4.0](https://github.com/Tah10n/pocket-ai/compare/v1.3.3...v1.4.0) (2026-05-16)


### Features

* **storage:** add quarantine cleanup action ([eaf5426](https://github.com/Tah10n/pocket-ai/commit/eaf5426276b6e35a1a62225e4b45a539b6ff1caf))


### Bug Fixes

* **chat:** harden assistant patch and branch edits ([a3ae5da](https://github.com/Tah10n/pocket-ai/commit/a3ae5da17c23363c56b882ea3114f88c3945556e))
* **chat:** harden persistence recovery paths ([fef5022](https://github.com/Tah10n/pocket-ai/commit/fef5022b74e103021d93918ac408580038af062c))
* **chat:** harden streaming persistence flushes ([43591cc](https://github.com/Tah10n/pocket-ai/commit/43591cc94f0f2ae76e054a01c3d673e785e10e62))
* **chat:** make clear tombstones authoritative ([58f5d9c](https://github.com/Tah10n/pocket-ai/commit/58f5d9cb5ad1640d84db9fbdafda5b5bdef53779))
* **chat:** make summary affordance unavailable ([683f31f](https://github.com/Tah10n/pocket-ai/commit/683f31f39a5a3058d2feb5358d8e52b15348abed))
* **chat:** preserve blank active thread selection ([a002ec0](https://github.com/Tah10n/pocket-ai/commit/a002ec06caa71b6804e19257585195d7c07fe2d2))
* **chat:** preserve post-clear persistence records ([9aca687](https://github.com/Tah10n/pocket-ai/commit/9aca687fd576eb7eee4028d1b0fcd88efb63c331))
* **chat:** prevent phantom persisted assistant placeholders ([2252c6a](https://github.com/Tah10n/pocket-ai/commit/2252c6ad0e83d5cdc64b3a327fdeb1aabdcece36))
* **download:** harden model file lifecycle guards ([e7900f3](https://github.com/Tah10n/pocket-ai/commit/e7900f31803284adad787bdc557fb7658d154859))
* **download:** harden queue failure handling ([7d7f209](https://github.com/Tah10n/pocket-ai/commit/7d7f209ffbbe6a925088a1a9326995beb34c5eff))
* **download:** harden retry recovery paths ([6eb1411](https://github.com/Tah10n/pocket-ai/commit/6eb14115bfa2374136ee9088c0f456d10a3958eb))
* **download:** keep pre-download failures explicit ([b709559](https://github.com/Tah10n/pocket-ai/commit/b709559ddc64b2584e22723e523c54c362887d92))
* **download:** preserve legacy partial filenames ([6ae9324](https://github.com/Tah10n/pocket-ai/commit/6ae9324b99e388a6322b31495cdf491409ca3812))
* **download:** tighten model file integrity verification ([4607319](https://github.com/Tah10n/pocket-ai/commit/4607319515fd817f92f36bd5a04b9111daadcedd))
* **engine:** avoid jinja prompt marker role wrapping ([8deb337](https://github.com/Tah10n/pocket-ai/commit/8deb33712c6875289849f2bc12fc79ddb3021844))
* **engine:** bound active context operations during unload ([1f9ab18](https://github.com/Tah10n/pocket-ai/commit/1f9ab18b6712606b02ad8d1c37bf37ad1da906b1))
* **engine:** bound completion unload ([81ad7d4](https://github.com/Tah10n/pocket-ai/commit/81ad7d49bfc73cf2e5516eb5e29d23f99f0625e3))
* **engine:** cancel timed-out context operations ([d676fdd](https://github.com/Tah10n/pocket-ai/commit/d676fddcaa2fdf47367631e6e1224919eb383dd9))
* **engine:** handle low-memory unload failures ([6cc847e](https://github.com/Tah10n/pocket-ai/commit/6cc847e3e1a2b86ccbef46cca687367e524d158d))
* **engine:** harden LLM lifecycle shutdown ([#96](https://github.com/Tah10n/pocket-ai/issues/96)) ([f0facd1](https://github.com/Tah10n/pocket-ai/commit/f0facd1c7dcdf5f0d1b2c0e884783346379830a9))
* **engine:** make strict role normalization template-aware ([356f28b](https://github.com/Tah10n/pocket-ai/commit/356f28b18d92596e202cb0ca8943c71f0832cbe1))
* **files:** harden model path and filename handling ([a0bacce](https://github.com/Tah10n/pocket-ai/commit/a0bacce851a0d26bb4ebc1e9a4b827646c944523))
* harden chat persistence ([e1fe361](https://github.com/Tah10n/pocket-ai/commit/e1fe361e2c75db37869ac7a40681af4fa1bffaf8))
* **ios:** import Foundation for backup exclusion plugin ([46d709e](https://github.com/Tah10n/pocket-ai/commit/46d709e132937f710d40c08d7746d116b8a48585))
* **models:** clear local runtime state after offload ([6513279](https://github.com/Tah10n/pocket-ai/commit/6513279cbb5f846858b00f0a5b623dedffab02cd))
* **models:** clear stale runtime metadata on path reset ([09edb3b](https://github.com/Tah10n/pocket-ai/commit/09edb3b51289094f129ace3e2fe15cc8bdd90fd4))
* **models:** harden local model file lifecycle ([#95](https://github.com/Tah10n/pocket-ai/issues/95)) ([8d65c67](https://github.com/Tah10n/pocket-ai/commit/8d65c67ce0c09fa0c0118b2de862803635c8300a))
* **models:** preserve download integrity state ([55aa499](https://github.com/Tah10n/pocket-ai/commit/55aa49930421ab0af2af4980a455a45f9f3071d2))
* **presets:** recover from corrupt preset storage ([edf5bf1](https://github.com/Tah10n/pocket-ai/commit/edf5bf1c79c17b5637aa51c745fc3ab8931f76ab))
* **presets:** use collision-safe preset ids and clear preset origin semantics ([890cba4](https://github.com/Tah10n/pocket-ai/commit/890cba4e6b72862516664ecd1156bb1603b4ad74))
* **registry:** ignore stale local paths in model file lifecycle ([25b5542](https://github.com/Tah10n/pocket-ai/commit/25b55422b6ef65123c56ae598cfb60822152c8a5))
* **registry:** quarantine orphaned model files before deletion ([dfb384a](https://github.com/Tah10n/pocket-ai/commit/dfb384a08a6fb00ac2ad12319301c1f99bee8f60))
* **settings:** harden preset and settings schema recovery ([4ef015d](https://github.com/Tah10n/pocket-ai/commit/4ef015df19d200da70ab8eba4d2eb933eb86c6fd))
* **settings:** normalize advanced model load parameters consistently ([9ba599a](https://github.com/Tah10n/pocket-ai/commit/9ba599abe97e0e41a07934179591f8f56f7010e8))
* **settings:** persist sanitized settings migrations once ([634d0f6](https://github.com/Tah10n/pocket-ai/commit/634d0f6947cb14f60db5d7466d8ed70f4a9c889e))
* **settings:** reject ambiguous CPU mask whitespace ([07c89b3](https://github.com/Tah10n/pocket-ai/commit/07c89b33e85ce939bf769258e31b30f163e23a65))
* **storage:** guard model file cleanup paths ([0e2c1dd](https://github.com/Tah10n/pocket-ai/commit/0e2c1dd692840073da38f1e17904c70b61ddb682))
* **storage:** harden quarantine cleanup ([a8ea696](https://github.com/Tah10n/pocket-ai/commit/a8ea696d47274dd3210808ed88e3dc2588aef0c1))


### Performance Improvements

* **engine:** reduce stop-token cache key cost ([c2a3442](https://github.com/Tah10n/pocket-ai/commit/c2a34428bbec0cdd8a1ecb063785af44edb9387d))
* reduce startup catalog prefetch ([0463f2c](https://github.com/Tah10n/pocket-ai/commit/0463f2c38cc58d8438d39d081f1112bb9f2217a6))
* reduce startup catalog prefetch ([5379d6a](https://github.com/Tah10n/pocket-ai/commit/5379d6adbd811fa14b3ae699378218abb9782cd6))
* **storage:** bound recursive directory size scans ([d912220](https://github.com/Tah10n/pocket-ai/commit/d912220a2b9c3edfcab2208b118947255e1d8713))

## [1.3.3](https://github.com/Tah10n/pocket-ai/compare/v1.3.2...v1.3.3) (2026-05-11)


### Bug Fixes

* **ui:** align glass user chat bubbles ([4af5825](https://github.com/Tah10n/pocket-ai/commit/4af58256cf9a3f90caa1d1ed4fde59622e2b039a))
* **ui:** polish dark glass chat surfaces ([#89](https://github.com/Tah10n/pocket-ai/issues/89)) ([5f656e3](https://github.com/Tah10n/pocket-ai/commit/5f656e3c5315c14428b403244fecd36324af11f9))
* **ui:** remove dark glass input fill ([7c44936](https://github.com/Tah10n/pocket-ai/commit/7c44936b34a6ef87890aa7dc4a33e7a1dd8ce0fb))

## [1.3.2](https://github.com/Tah10n/pocket-ai/compare/v1.3.1...v1.3.2) (2026-05-08)


### Bug Fixes

* fail closed private storage recovery ([42d3361](https://github.com/Tah10n/pocket-ai/commit/42d3361c3139ff1da12a9e252dc820f1d578eae8))
* harden private storage recovery ([bc28d70](https://github.com/Tah10n/pocket-ai/commit/bc28d70103122abf9038f9b7f56d2371f52fa914))
* harden private storage recovery flow ([1df6312](https://github.com/Tah10n/pocket-ai/commit/1df6312ef38003922e3a577e484a9ac8273bd9ee))
* harden private storage reset recovery ([6ac4a46](https://github.com/Tah10n/pocket-ai/commit/6ac4a46fcfb6639dd9c7fd71e6f2f6d494fb1919))
* preserve typed private storage migrations ([5481c0a](https://github.com/Tah10n/pocket-ai/commit/5481c0a8cd2926272da14ec324d7b349c8857f54))
* **storage:** enforce fail-closed private writes ([dc4562c](https://github.com/Tah10n/pocket-ai/commit/dc4562c4cdfcedfd7bb40560509da0b2d8b4eb3a))
* **storage:** fail closed for private store mutations ([6cff72a](https://github.com/Tah10n/pocket-ai/commit/6cff72a21bedb8396e7940b2a5a0b14446ee617b))
* **storage:** fail closed for private store mutations ([#82](https://github.com/Tah10n/pocket-ai/issues/82)) ([6e40678](https://github.com/Tah10n/pocket-ai/commit/6e406783d4f1a732c014d90e09ac2cef42a6cf2b))
* **storage:** harden private MMKV recovery ([86bd0a3](https://github.com/Tah10n/pocket-ai/commit/86bd0a39a09246bebe4eac2815daaaa27ebd757d))
* **storage:** preserve model files after private reset ([275c1e2](https://github.com/Tah10n/pocket-ai/commit/275c1e22edfad350b4aa79ee091dc06a52da3af3))
* **storage:** preserve typed private MMKV migration ([427067b](https://github.com/Tah10n/pocket-ai/commit/427067b1c5531c8196b0040342569197d63483f9))
* **storage:** recover encrypted MMKV with keyed open ([add2d73](https://github.com/Tah10n/pocket-ai/commit/add2d73bf807ee2e8dbe5f306c771ccfa923ee9c))
* **storage:** refine recovery screen panels ([e1cd5ac](https://github.com/Tah10n/pocket-ai/commit/e1cd5ac2ceda08912f8fca78077f0a6a0ab998f4))

## [1.3.1](https://github.com/Tah10n/pocket-ai/compare/v1.3.0...v1.3.1) (2026-05-05)


### Bug Fixes

* guard chat completion context freshness ([1f05a16](https://github.com/Tah10n/pocket-ai/commit/1f05a1666d1521575ec7e752465fd15de3ba0319))
* harden chat cancellation lifecycle ([71b4daf](https://github.com/Tah10n/pocket-ai/commit/71b4daf8fba1e66b12d5c047cf7599e71521e725))
* harden chat completion lifecycle ([3be59cc](https://github.com/Tah10n/pocket-ai/commit/3be59cc42f5f58ab92f69c7491bcb25bc40a6343))
* harden chat lifecycle and catalog cache ([40c66d7](https://github.com/Tah10n/pocket-ai/commit/40c66d76fa3fb292f95b51ce9fa328cb8e7d9b4e))
* harden chat stop and probe lifecycle ([5601601](https://github.com/Tah10n/pocket-ai/commit/56016014f116e3f7a09e1cbb7ec0335ad566b102))
* harden generation cancellation edge cases ([de1a155](https://github.com/Tah10n/pocket-ai/commit/de1a155804130b1e55e0363307901305bb3961e5))
* honor stops before native generation ([0111ba6](https://github.com/Tah10n/pocket-ai/commit/0111ba6acb5e22f9d6a37f32415bf9ae5148921c))
* improve memory budget portability ([#69](https://github.com/Tah10n/pocket-ai/issues/69)) ([fb5e493](https://github.com/Tah10n/pocket-ai/commit/fb5e49392e9bf2fc7b74de3b54e5adf5ae2ec7fb))
* keep llama parallel slots disabled ([42de6f7](https://github.com/Tah10n/pocket-ai/commit/42de6f7f4f8d684cd37f702e3ff76808ea2aec52))
* lock chat completions during preparation ([6830fda](https://github.com/Tah10n/pocket-ai/commit/6830fda7798fe44c1c8f23c97c74d0a15002ff5a))


### Performance Improvements

* cache chat template stop tokens safely ([93d5e87](https://github.com/Tah10n/pocket-ai/commit/93d5e874599f9c1e080cdac42f3ce14ba2c6647a))

## [1.3.0](https://github.com/Tah10n/pocket-ai/compare/v1.2.0...v1.3.0) (2026-05-03)


### Features

* refine glass visual design ([#65](https://github.com/Tah10n/pocket-ai/issues/65)) ([4ecd0ab](https://github.com/Tah10n/pocket-ai/commit/4ecd0ab6b06a6ce3cff182b13365abdc94d62f85))


### Bug Fixes

* respect native bottom safe areas ([#64](https://github.com/Tah10n/pocket-ai/issues/64)) ([a58f6a8](https://github.com/Tah10n/pocket-ai/commit/a58f6a8bb0d2ba630712c13c7b80382c50bc168e))

## [1.2.0](https://github.com/Tah10n/pocket-ai/compare/v1.1.2...v1.2.0) (2026-04-23)


### Features

* allow model switching within a conversation ([#55](https://github.com/Tah10n/pocket-ai/issues/55)) ([0b55f65](https://github.com/Tah10n/pocket-ai/commit/0b55f65b7a8ffea7eba0d5eacb59f855ecd9a483))

## [1.1.2](https://github.com/Tah10n/pocket-ai/compare/v1.1.1...v1.1.2) (2026-04-21)


### Bug Fixes

* harden app reliability and release flow ([#49](https://github.com/Tah10n/pocket-ai/issues/49)) ([a5f2e65](https://github.com/Tah10n/pocket-ai/commit/a5f2e6556c8a545e59b475f27fd4a77a2769c26c))

## [1.1.1](https://github.com/Tah10n/pocket-ai/compare/v1.1.0...v1.1.1) (2026-04-16)


### Bug Fixes

* harden model orchestration ([#38](https://github.com/Tah10n/pocket-ai/issues/38)) ([52613ab](https://github.com/Tah10n/pocket-ai/commit/52613ab053940f4054444b3bf06cd9d82bc86110))
* stabilize llama.rn integration and backend inference policy ([#42](https://github.com/Tah10n/pocket-ai/issues/42)) ([d5faec9](https://github.com/Tah10n/pocket-ai/commit/d5faec9763b157277c545e4df78395aa1e25e724))
* **ui:** make chat messages text-selectable ([#36](https://github.com/Tah10n/pocket-ai/issues/36)) ([049ceaa](https://github.com/Tah10n/pocket-ai/commit/049ceaafd857631a5ec744ced450bbc3ce629caf))

## [1.1.0](https://github.com/Tah10n/pocket-ai/compare/v1.0.0...v1.1.0) (2026-04-08)


### Features

* **active-model-card:** display size using decimal gigabyte constant ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **agent:** add support for new 'kimi' agent in update-agent-context.ps1 ([525d2c7](https://github.com/Tah10n/pocket-ai/commit/525d2c7fe83559042ebbdfbf4bd9080e37745b63))
* **android:** add Android system RAM metrics via native module ([0b2ac28](https://github.com/Tah10n/pocket-ai/commit/0b2ac284b75f87cd452566b7ebe20dc837f8992d))
* **android:** add automated Android smoke and UI scenario tests ([63bd404](https://github.com/Tah10n/pocket-ai/commit/63bd4041a0c9d82251f15ad4297ff120570bf0bd))
* **app-bootstrap:** improve background bootstrap error handling and outcome reporting ([d0ddc76](https://github.com/Tah10n/pocket-ai/commit/d0ddc7681a2cbfe2a6c1cffd17066c232811ec28))
* **app-error:** add support for download_metadata_unavailable error code ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **chat:** add bounded token budget and improve generation reliability ([e0a55f1](https://github.com/Tah10n/pocket-ai/commit/e0a55f1513b90c3756305eb47bcb5a6837631c4c))
* **chat:** enhance ChatHeader with preset selector button ([9df6a1e](https://github.com/Tah10n/pocket-ai/commit/9df6a1e0e269d47266ef88b31ada867346145090))
* **chat:** replace FlatList with FlashList for chat messages ([96e8f9e](https://github.com/Tah10n/pocket-ai/commit/96e8f9ec88fce13dfd5b89ee75ecd49bb2c866dd))
* **conversations:** add full conversation-management flow with search and rename ([891979c](https://github.com/Tah10n/pocket-ai/commit/891979ca4795d00acf9a50840b186407a2618e34))
* **core:** enhance model controls, settings, and storage management ([44c0abe](https://github.com/Tah10n/pocket-ai/commit/44c0abec98e8d6d7940ba424b324f4a207ea5004))
* **engine:** allow forced model loads despite memory warnings ([186b861](https://github.com/Tah10n/pocket-ai/commit/186b86136d379b6a67d040cbed1d8b629cdffa4f))
* **hooks:** use getFreshMemorySnapshot in useDeviceMetrics hook ([851228e](https://github.com/Tah10n/pocket-ai/commit/851228e8a9c4acb0650a28d292789dbfee49ed5e))
* **huggingface-token:** add support for Hugging Face access token management ([499ff21](https://github.com/Tah10n/pocket-ai/commit/499ff213465a82843b92e6f2ecabc0f08605f4ad))
* **i18n:** add new download metadata unavailable error message translation ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* Initialize application structure with core UI screens, components, state management, and build configurations. ([da34e7c](https://github.com/Tah10n/pocket-ai/commit/da34e7cf4b6c8668636f422bfb6120ac0c5edc5f))
* Initialize application with core UI, services, testing, and specification-driven development setup. ([7640258](https://github.com/Tah10n/pocket-ai/commit/764025837f98487923dc6b0b76ac739e77d9ff82))
* **LLMEngineService:** normalize and merge messages to fix role alternation errors ([fe6191d](https://github.com/Tah10n/pocket-ai/commit/fe6191d42a8e7aab6f72a34e369ab86d32793272))
* **memory:** block loading models fitting only minimal context window ([eb3f0cf](https://github.com/Tah10n/pocket-ai/commit/eb3f0cf6dd4f0346b018bd640b2134cf26977643))
* **memory:** block model load if safe profile exceeds RAM budget ([6986cfa](https://github.com/Tah10n/pocket-ai/commit/6986cfa61fc35222a01bcad5e377c28de2984d48))
* **model-card:** show warning badge for unknown model size ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **model-catalog:** exclude unsupported image and diffusion models in search ([14d03a7](https://github.com/Tah10n/pocket-ai/commit/14d03a757b63d20663a4b3a2bd328f238ea28e3c))
* **model-details:** create reusable UI components for model details screen ([b84a3db](https://github.com/Tah10n/pocket-ai/commit/b84a3db38f73bb3cd7b03de27fce58513fdbf224))
* **ModelCatalogService:** add cache invalidation source tracking and force refresh option ([fe6191d](https://github.com/Tah10n/pocket-ai/commit/fe6191d42a8e7aab6f72a34e369ab86d32793272))
* **modelControls:** add seed and KV cache precision options for generation ([c4b52a7](https://github.com/Tah10n/pocket-ai/commit/c4b52a76be8b386eb326d6747488c99bf3864a4a))
* **models-list:** auto load more models with RAM/token filters and handle unknown sizes ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **models:** add model filtering, sorting, and pagination with enhanced catalog fetch ([b42fb6f](https://github.com/Tah10n/pocket-ai/commit/b42fb6fbe84729d57fad15af4ac51c9938a46fe8))
* **models:** implement cursor-based pagination and gated model states for catalog ([27c91de](https://github.com/Tah10n/pocket-ai/commit/27c91de73ee29b754f95e096a8dd82f59cb508bc))
* **ModelsList:** add pull-to-refresh support for model lists ([fe6191d](https://github.com/Tah10n/pocket-ai/commit/fe6191d42a8e7aab6f72a34e369ab86d32793272))
* **performance-export:** truncate long logcat event messages to avoid truncation issues ([d0ddc76](https://github.com/Tah10n/pocket-ai/commit/d0ddc7681a2cbfe2a6c1cffd17066c232811ec28))
* **performance:** add app-wide performance monitoring and debug screen ([adfd1a9](https://github.com/Tah10n/pocket-ai/commit/adfd1a9f636a72d62d01d6a899b10ed0f2760ec3))
* **performance:** add performance monitoring and export utilities ([1f77afd](https://github.com/Tah10n/pocket-ai/commit/1f77afd7df8cb1ccb358b6b0cee6ca86346fe9a8))
* **plugin:** add iOS system metrics plugin and enhance Android plugin ([851228e](https://github.com/Tah10n/pocket-ai/commit/851228e8a9c4acb0650a28d292789dbfee49ed5e))
* **react-native:** migrate app to new architecture with Fabric and TurboModules ([10aaff0](https://github.com/Tah10n/pocket-ai/commit/10aaff00a480c13d88bd0ac838ba9802b34685e4))
* **recentconversations:** add manage button on recent conversations header ([9df6a1e](https://github.com/Tah10n/pocket-ai/commit/9df6a1e0e269d47266ef88b31ada867346145090))
* **root-layout:** split bootstrap into critical and background phases with performance marks ([1f77afd](https://github.com/Tah10n/pocket-ai/commit/1f77afd7df8cb1ccb358b6b0cee6ca86346fe9a8))
* **security:** validate and sanitize local model file paths ([0531806](https://github.com/Tah10n/pocket-ai/commit/05318060327d5942868491b5f9478660dbe9bf62))
* **settings:** implement theme, language, and preset management with localization ([ed25daf](https://github.com/Tah10n/pocket-ai/commit/ed25dafb303a0d4fe64f9b2b3fb7a000a6a19bcd))
* The basic structure of the project with the main UI screens, services and configuration has been initialized. ([e5f7ec3](https://github.com/Tah10n/pocket-ai/commit/e5f7ec32d5ed6c406e9cacf43a556e34318339be))
* **ui:** add ActiveModelHeroCard component with memory usage and controls ([525d2c7](https://github.com/Tah10n/pocket-ai/commit/525d2c7fe83559042ebbdfbf4bd9080e37745b63))
* **ui:** add ChatHeader component with back, menu, and labels ([525d2c7](https://github.com/Tah10n/pocket-ai/commit/525d2c7fe83559042ebbdfbf4bd9080e37745b63))
* **ui:** add error report sheet for model load failures ([a859b05](https://github.com/Tah10n/pocket-ai/commit/a859b05cc9c6e58e54e67515b14610454e82f099))
* **ui:** add ModelCard and SearchHeader components for model management ([9565d44](https://github.com/Tah10n/pocket-ai/commit/9565d44ea0f3d70ccdc5fc7a05ae371783961e77))
* **ui:** add shared ScreenShell for consistent screen layouts ([7cf366c](https://github.com/Tah10n/pocket-ai/commit/7cf366c3de93ef0a82a59b695b236fd51fbb2dfe))
* **use-device-metrics:** use decimal gigabyte constant for byte conversion ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **use-model-details-controller:** handle gated/private model metadata refresh ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **utils:** improve isHuggingFaceUrl detection logic ([07fbc8e](https://github.com/Tah10n/pocket-ai/commit/07fbc8e6bf49f5d6b26587b3aa6270ee04e69c17))


### Bug Fixes

* **android-utils:** handle offline devices and unlock on android smoke tests ([1f77afd](https://github.com/Tah10n/pocket-ai/commit/1f77afd7df8cb1ccb358b6b0cee6ca86346fe9a8))
* **chatinputbar:** center single-line text input vertically ([9df6a1e](https://github.com/Tah10n/pocket-ai/commit/9df6a1e0e269d47266ef88b31ada867346145090))
* **conversations:** use router.push instead of replace for navigation transitions ([6a4fcc7](https://github.com/Tah10n/pocket-ai/commit/6a4fcc742e8801ed886ef09c7594aa95b22ee113))
* **device-metrics:** prefer resident memory over appUsedBytes on Android ([14d03a7](https://github.com/Tah10n/pocket-ai/commit/14d03a757b63d20663a4b3a2bd328f238ea28e3c))
* **hardware-listener-service:** correctly handle unknown network reachability ([51c4225](https://github.com/Tah10n/pocket-ai/commit/51c4225862e39a3afeb860af0d7af506b6a4ef42))
* **llm-engine:** adjust message merging logic to avoid extra whitespace ([d0ddc76](https://github.com/Tah10n/pocket-ai/commit/d0ddc7681a2cbfe2a6c1cffd17066c232811ec28))
* **local-storage-registry:** optimize garbage collection with Sets for lookup ([d0ddc76](https://github.com/Tah10n/pocket-ai/commit/d0ddc7681a2cbfe2a6c1cffd17066c232811ec28))
* **memory:** improve iOS memory metrics calculation and modelsStore persistence merge ([f2b4a46](https://github.com/Tah10n/pocket-ai/commit/f2b4a461918ba0c171278ffceb4b85b15c0af814))
* **model-catalog:** handle 404 for gated and private models without throwing ([dc8acba](https://github.com/Tah10n/pocket-ai/commit/dc8acba36128a210cd3831543cc9ed1309e1c725))
* **model-catalog:** implement conditional auth headers for model requests ([d4a7cc6](https://github.com/Tah10n/pocket-ai/commit/d4a7cc6280ac84407af1cda4ce439bccce23a7cc))
* **model-details:** update icon container styles for consistent appearance ([1f77afd](https://github.com/Tah10n/pocket-ai/commit/1f77afd7df8cb1ccb358b6b0cee6ca86346fe9a8))
* **models:** keep incomplete tree probes unresolved ([34de819](https://github.com/Tah10n/pocket-ai/commit/34de819794f021e46bd2e6aeb0e3911e588ca9cb))
* **performance-screen:** remove unnecessary isFocused check in interval effect ([d0ddc76](https://github.com/Tah10n/pocket-ai/commit/d0ddc7681a2cbfe2a6c1cffd17066c232811ec28))
* **powershell:** add quiet flag to git branch creation command ([525d2c7](https://github.com/Tah10n/pocket-ai/commit/525d2c7fe83559042ebbdfbf4bd9080e37745b63))
* **settings:** refine UI and remove deprecated styles ([4046714](https://github.com/Tah10n/pocket-ai/commit/4046714b4b1908e0baef04c62582729f613bf998))
* **storage:** add fallback memory storage and error reporting ([42832a0](https://github.com/Tah10n/pocket-ai/commit/42832a089842b1574a6ba4aeac8006e056603a74))
* **storage:** correct naming and length checks for encryption key constants ([dc8acba](https://github.com/Tah10n/pocket-ai/commit/dc8acba36128a210cd3831543cc9ed1309e1c725))
* **StorageManagerService:** specify manual source when clearing model catalog cache ([fe6191d](https://github.com/Tah10n/pocket-ai/commit/fe6191d42a8e7aab6f72a34e369ab86d32793272))
* **ui:** adjust layout for empty conversations in ConversationSwitcherSheet and ConversationsScreen ([ffd06b6](https://github.com/Tah10n/pocket-ai/commit/ffd06b64f177940236281fae4fc69ba27ce53795))
* **ui:** conditionally define onBack handler in ChatScreen based on router state ([6a4fcc7](https://github.com/Tah10n/pocket-ai/commit/6a4fcc742e8801ed886ef09c7594aa95b22ee113))
* **ui:** constrain model download progress between 0 and 100 percent ([6a4fcc7](https://github.com/Tah10n/pocket-ai/commit/6a4fcc742e8801ed886ef09c7594aa95b22ee113))
* **ui:** correct ScreenActionPill className handling for text tone styling ([6a4fcc7](https://github.com/Tah10n/pocket-ai/commit/6a4fcc742e8801ed886ef09c7594aa95b22ee113))
* **ui:** only update ModelDetails state when modelId changes ([6a4fcc7](https://github.com/Tah10n/pocket-ai/commit/6a4fcc742e8801ed886ef09c7594aa95b22ee113))
* **ui:** strengthen openMarkdownUrl type and safety checks ([07fbc8e](https://github.com/Tah10n/pocket-ai/commit/07fbc8e6bf49f5d6b26587b3aa6270ee04e69c17))


### Performance Improvements

* **models-list:** add performance spans and marks for catalog fetch and first results ([1f77afd](https://github.com/Tah10n/pocket-ai/commit/1f77afd7df8cb1ccb358b6b0cee6ca86346fe9a8))
* **use-chat-session:** add performance marks and spans for chat generation lifecycle ([1f77afd](https://github.com/Tah10n/pocket-ai/commit/1f77afd7df8cb1ccb358b6b0cee6ca86346fe9a8))

## [1.0.0] - 2026-04-08

### Added
- Model controls: seed (random vs fixed) for reproducible generation.
- Load profiles: KV cache precision selector (`auto`, `f16`, `q8_0`, `q4_0`).

### Changed
- Model loading: improved GPU-layer recommendations and safer fallback behavior when GPU initialization fails.
