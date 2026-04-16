# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: This file is maintained automatically by Release Please based on Conventional Commits (PR titles).
> Avoid editing it manually unless you are bootstrapping or fixing the release history.

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
