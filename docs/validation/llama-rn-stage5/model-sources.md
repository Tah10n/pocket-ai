# Stage 5 retrieval fixtures

These identities and relevance labels were fixed on 2026-09-30 before native retrieval results. They establish metadata and preprocessing contracts; they do not establish successful native search or ranking. The fixed corpus and model manifests are in [retrieval-fixtures.json](retrieval-fixtures.json).

## Selected artifacts

| Role | Pinned artifact | Bytes | Published SHA-256 | Terms |
| --- | --- | ---: | --- | --- |
| Embedding | [TwinSunsLLC multilingual-e5-small Q8_0](https://huggingface.co/TwinSunsLLC/multilingual-e5-small-gguf/tree/b6cac9615d4ecce28d7f22539b7322d695fc2886) | 132439008 | `e011debc1208e31bf7b6aebee2d9fc8bd2ca11694a77ed66ac9d0c9d0a877c93` | MIT |
| Reranker | [GPUStack bge-reranker-v2-m3 Q4_K_M](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/blob/3093af03b1a635e67b084b1d8c03c5f5e020fd05/bge-reranker-v2-m3-Q4_K_M.gguf) | 438376864 | `e186a244ed455b4ab66ec64339ce7427a6ae13f5c0b5e544de96e50f0f8b3673` | Apache-2.0 |

Repository revisions are `b6cac9615d4ecce28d7f22539b7322d695fc2886` and `3093af03b1a635e67b084b1d8c03c5f5e020fd05`. SHA-256 values and sizes were checked against the publishers' Hugging Face LFS manifests. Runtime file verification must hash the downloaded bytes. The pair occupies approximately 544 MiB on disk; the contexts run sequentially. Weights are not committed.

The embedding's [upstream model](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3) declares 384 dimensions, mean pooling followed by L2 normalization, and multilingual support including English and Russian. Retrieval inputs require the exact `query: ` and `passage: ` prefixes, including for Russian. Its MIT terms permit reuse subject to the license notice. The [conversion card](https://huggingface.co/TwinSunsLLC/multilingual-e5-small-gguf) documents its XLM-R tokenizer conversion.

The [reranker's upstream model](https://huggingface.co/BAAI/bge-reranker-v2-m3/tree/953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e) declares a multilingual XLM-R sequence classifier under Apache-2.0. Its documented input is a query/passage pair without embedding instructions. Preserve required Apache notices when redistributing weights. English and Russian are the acceptance scope; other languages have no acceptance claim here. A rank score expresses relative relevance and is not the probability that a document answers a question.

## Native contract and limits

The inspected runtime is `llama.rn` `0.13.0-rc.3`, upstream tag commit [`6cf681be300bc115e6580dd120e7e7606906dacd`](https://github.com/mybigday/llama.rn/tree/6cf681be300bc115e6580dd120e7e7606906dacd), with the application's existing guarded source patch. Sources of truth are installed `src/index.ts`, `src/types.ts`, `cpp/jsi/RNLlamaJSI.cpp`, `cpp/jsi/JSIParams.cpp`, `cpp/rn-completion.cpp`, `cpp/rn-common.hpp`, and `cpp/llama-vocab.cpp`.

- Embeddings use `embedding: true`, `pooling_type: 'mean'`, and `embedding(text, { embd_normalize: 2 })`. The result is `{ embedding: number[] }`. Native normalization `-1` means none, `0` means max-absolute scaling, `1` means L1, and `2` means L2. Per-token pooling is unsupported for document vectors; native `pooling_type: 'none'` exposes only its first embedding row through this API.
- Rerank uses an independent `embedding: true`, `pooling_type: 'rank'` context and `rerank(query, documents, {})`. The nonparallel bridge ignores its advertised `normalize` argument and returns raw rank scores. JavaScript sorts scores while preserving each original `index`; callers must validate and map those indexes. Native missing-output/errors may produce the sentinel `-1000000`, which is an operation failure, not a meaningful relevance score.
- Use bounded CPU profiles with `n_ctx: 512`, `n_batch: 512`, `n_parallel: 1`, `ctx_shift: false`, `state_cache_budget_mb: 0`, and `state_cache_max_checkpoints: 8`. Embedding initialization sets `n_ubatch` equal to `n_batch`, overriding a separate request. Keep every complete noncausal input in that batch. Memory admission must include model, work buffers, documents, indexes, and chat restoration.
- `tokenize(text)` has `add_special=false`, `parse_special=true`. Embedding evaluation adds automatic specials. Prefixes must be present before token counting. The E5 artifact declares `bert.context_length=511`, despite the upstream/card limit of 512; the accepted input cap is 511 tokens including its two automatic specials. Long chunks must be split and checked before evaluation.
- Native `embedding()` contains a function-static dimension initialized by its first call. Under the unchanged source patch, a process must reject a later embedding context with a different `model.nEmbd` before calling `embedding()`, including across auxiliary QA and retrieval. The selected E5 and earlier MiniLM fixture both have 384 dimensions; this is an artifact-specific restriction, not a universal vector dimension.
- `stopCompletion()` only sets a completion interruption flag. `rerank()` clears that flag for each subsequent candidate and has no operation-wide cancel/result flag. Stop prevents subsequent calls, retains ownership, and awaits the entire in-flight bounded rerank batch before release. The batch contains at most eight pairs; parallel mode remains off.

## Exact token formatting

Both selected GGUF metadata streams were read through their tensor descriptor tables and closed before tensor weights. No model file was saved by the metadata inspection. The descriptors confirm a BERT mean-pooling E5 model and a BGE dense/tanh classification head with a scalar output.

Both use `tokenizer.ggml.model='t5'`, representing the XLM-R unigram tokenizer, BOS ID 0 and EOS/separator ID 2. E5 enables BOS, EOS, and separator. The pinned BGE conversion enables BOS and EOS but omits `add_sep_token`; native unigram defaults separator insertion to false.

For that BGE artifact, `format_rerank_tokens()` builds `[BOS] query [EOS] document [EOS]`. It detokenizes the token sequence and evaluates it through `loadPrompt`, which adds a further BOS and EOS. Thus actual special overhead is five, and the actual format differs from the upstream Hugging Face pair separator layout. This is a pinned-runtime formatting limitation whose effect must be measured in native corpus results; metadata does not establish ranking quality.

Before each call, tokenize query and document separately, construct that exact native token sequence, call native `detokenize`, then native `tokenize` on the resulting text and add the two automatic outer specials. Reject any count above 511. Adding raw text token counts alone does not reproduce the native re-tokenization step. `src/services/DocumentRetrievalProfiles.ts` supplies the pinned profile and token template; the caller supplies the actual source-patch identity in the index fingerprint.

## Fixed corpus

The corpus contains four small synthetic direct-text documents and twelve prelabelled English/Russian queries. Cases cover paraphrases, exact codes, similar irrelevant passages, and retrieval across documents and languages. IDs identify document paragraphs; extractors supply real structural chunk IDs and locators. No page, slide, sheet, or byte offset is fabricated.

Run all queries in lexical, hybrid, and hybrid with rerank modes. Record relevant paragraph rank and Recall@3, deduplicating embedding subchunks by original paragraph. Record actual selected chunks delivered to the chat prompt and all fallback/failure reasons. Keep measured results separate from the fixture labels, and do not replace poorly performing queries after observing results. Native acceptance is currently `not_run` in this fixture definition.
