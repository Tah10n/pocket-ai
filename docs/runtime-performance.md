# Runtime Performance Architecture

Last updated: 2026-07-20

## Purpose

Pocket AI has several runtime paths where work can accidentally grow with chat history,
stream length, catalog consumers, or concurrent storage callers. This document records
the contracts that keep those paths bounded and the deterministic evidence used to
protect them.

These are correctness contracts as much as performance contracts. An optimization must
not weaken cancellation, crash recovery, attachment validation, model-load safety, cache
invalidation, or diagnostics privacy.

## Core contracts

- Streaming token callbacks do not traverse or serialize the durable chat history.
- Historical message arrays and message objects keep their reference identity while the
  active assistant output changes.
- Attachment preparation is request-scoped, cancellable, and reused by token counting and
  completion.
- Exact prompt-token results are reused only when the loaded context and every formatting
  input have the same identity.
- Streaming progress is stored separately from the durable thread and is removed only
  after a successful terminal commit.
- Success, stop, and error finalization update the message, metrics, and thread state in
  one store mutation and one logical persistence transaction.
- Reasoning presentation parses normal delta streams in linear total character work.
- Model initialization never retries the same effective attempt in one load and preserves
  a bounded CPU fallback.
- Canceling one catalog consumer does not cancel independent consumers of shared work.
- Concurrent cache-size callers share one underlying native or JavaScript scan.

## Pipeline ownership

| Concern | Primary owner | Enforced boundary |
|---|---|---|
| Prompt-window display | [`useTruncationTracking.ts`](../src/hooks/useTruncationTracking.ts) | Reuse the last idle result while a thread is generating |
| Inference request preparation | [`useChatSession.ts`](../src/hooks/useChatSession.ts) | Resolve attachments and final messages once per request |
| Exact prompt counts | [`ExactPromptTokenCache.ts`](../src/services/ExactPromptTokenCache.ts) | Bounded LRU keyed by context and formatting identity |
| Transient assistant output | [`chatStore.ts`](../src/store/chatStore.ts) | Keep durable history stable during token patches |
| Streaming crash recovery | [`chatPersistence.ts`](../src/store/chatPersistence.ts) | Persist a bounded progress record, not the full thread |
| Terminal state | [`chatStore.ts`](../src/store/chatStore.ts) | One atomic terminal mutation and persistence transaction |
| Reasoning presentation | [`chatPresentation.ts`](../src/utils/chatPresentation.ts) | Incremental delta parser with explicit snapshot resynchronization |
| Model initialization | [`LLMEngineService.initRetryPolicy.ts`](../src/services/LLMEngineService.initRetryPolicy.ts) | Unique bounded attempts, OOM upper bounds, CPU fallback |
| Catalog requests | [`ModelCatalogService.ts`](../src/services/ModelCatalogService.ts) | Per-consumer sessions over reference-counted shared resources |
| Cache-size measurement | [`StorageManagerService.ts`](../src/services/StorageManagerService.ts) and [`SystemMetricsService.ts`](../src/services/SystemMetricsService.ts) | TTL cache plus generation-safe single-flight scans |

## Chat generation

### Stable history during streaming

The durable thread contains the assistant placeholder and all historical messages. A
transient runtime record owns the latest assistant content, reasoning content, token rate,
and a stable presentation array. Updating a token changes only the transient assistant
object and a streaming revision; it does not replace the durable thread, durable messages
array, or historical message objects.

The truncation hook returns the last idle truncation state before building a new inference
window when the thread is generating. The terminal transition invalidates that fast path
and performs one fresh calculation.

### Prepared inference requests

One generation request owns its attachment existence resolver and prepared message set.
Token counting, prompt-window selection, and completion reuse that prepared payload. A
stable retained URI is checked once per request. Cancellation checks remain between
preparation stages, and a final file check is reserved for a real time-of-check/time-of-use
boundary rather than repeated unconditionally.

The prompt preparation trace is split into:

- `chat.prompt.total`
- `chat.prompt.attachments`
- `chat.prompt.tokenize`
- `chat.prompt.finalize`

Metadata contains counts and outcomes, not prompt text, attachment paths, or file contents.

### Exact prompt-token cache

The exact-count cache is bounded by entry count and approximate bytes. Its key includes:

- loaded context generation and model identity;
- the inference-message signature, including roles, content, media, and content parts;
- multimodal/projector readiness identity;
- reasoning enablement and format;
- generation-prompt and media-fallback options.

Concurrent lookups share one native tokenization promise. Rejected operations are evicted
immediately. A result is retained only after a successful consumer release, so a canceled
request cannot populate the cache for later work.

### Streaming persistence and recovery

Streaming patches never enter durable-thread persistence. A debounced progress record
contains only the active assistant output and the identity needed to match it to the
durable placeholder. Background flush writes the latest progress immediately.

Hydration applies a progress record only when it is valid, newer than the durable thread,
and matches the thread. If an eligible assistant placeholder is present, its identity must
also match. Empty streaming placeholders are intentionally omitted from durable records,
so recovery may instead append the partial assistant as stopped when there is no newer or
conflicting terminal assistant. Corrupt, stale, or mismatched progress is ignored and
cleaned up. Thread deletion, retention cleanup, clear-all, and private-storage reset remove
associated progress records.

A terminal durable write happens before progress removal. If the durable write fails, the
progress record remains available for recovery.

### Atomic terminal outcomes

Success, stop, and error use the same terminal store operation. That operation validates
the current assistant message ID, materializes the latest transient output, applies
inference and MTP metrics, updates thread timestamps/status, and persists the result.

The operation is idempotent: a stale or repeated callback cannot commit a replacement
message or create a second terminal transaction.

### Incremental reasoning presentation

The parser accepts deltas, accumulated snapshots, explicit native reasoning, and mixed
callback modes. It supports the reasoning delimiters used by current llama.cpp-compatible
models, including tags split across callback boundaries. Delta input advances from the
previous parser state; a replacement snapshot may be processed once at snapshot length,
after which later deltas remain incremental.

The parser exposes a processed-character counter for deterministic complexity tests. It
does not invoke Markdown rendering on the streaming callback path.

## Model initialization

Initialization profiles and individual attempts have normalized identities. The retry
guard rejects exact duplicates, records probable-OOM upper bounds, and allows only safer
GPU-layer candidates under the same memory conditions. Layer retries are unique,
descending, and limited to four candidates. The overall profile list and accelerator
attempt count are bounded, while a CPU fallback is retained.

Speculative and base-only initialization are distinct attempts. A failed speculative MTP
attempt may fall back to the same base profile without MTP once; it does not make that base
attempt an unlimited retry path. Existing model-load progress throttling remains separate
from retry selection.

`model.init.attempt` spans and marks record normalized backend/profile fields, duration,
outcome, probable-OOM state, and a bounded failure category. Model paths and raw native
errors are not trace metadata.

## Catalog request ownership

Each mounted catalog hook owns a `CatalogSearchSession`. A query change or unmount cancels
only that session. Model-details calls accept their caller's `AbortSignal` and are not tied
to another screen's search generation.

Tree, readme, file-probe, and deferred-metadata requests can still be shared. Each shared
entry tracks its consumers; detaching one consumer removes its listener and rejects only
that consumer. The underlying request is aborted only after the last consumer detaches.
Settled and aborted entries are removed by identity so a late request cannot delete an
active replacement.

Manual cache clear remains global: it advances the cache generation, aborts catalog work,
and prevents late responses from repopulating cleared caches. Token changes cancel stale
authenticated work from an incompatible authorization epoch. They also clear model
snapshots, resolved probe state, and persisted snapshots so visibility is reconciled under
the new credentials. The models catalog UI requests pages of 8, and deferred metadata
remains a bounded batch of 4.

## Cache-size scans

`SystemMetricsService` coalesces direct Android bridge calls into one promise.
`StorageManagerService` adds a second single-flight boundary around the complete
native-to-JavaScript fallback operation and stores successful results in the existing
60-second TTL cache.

Clear, quarantine refresh, and quarantine cleanup advance a measurement generation,
clear the TTL cache, and detach active single-flight entries. A scan that started in an
older generation may finish for its original callers, but it cannot restore stale cache
state or remove a newer in-flight request. Rejections and filesystem failures are not
cached, so the next caller retries.

The live React Native `http-cache` directory is excluded from size reporting by both the
Android native implementation and the JavaScript fallback. The TypeScript
`clearActiveCache()` traversal separately excludes it from deletion.

## Runtime tracing

Open **Settings → Performance** to enable instrumentation, inspect counters/spans/events,
and copy, share, save, or dump a trace. Traces are held in memory and the event list is
bounded.

Important trace families include:

| Family | What it establishes |
|---|---|
| `chat.prompt.*` | Attachment, tokenization, window, and final preparation stages |
| `chat.stream.patch` and `chat.stream.historyTraversal` | Streaming patch count and accidental history traversal |
| `chat.persist.*` | Sanitization, serialization, storage writes, bytes, progress, and terminal writes |
| `chat.turn.*` | Terminal mutation and persistence-transaction counts |
| `model.init.attempt` | Bounded model-load attempt sequence and sanitized outcomes |
| `catalog.search.*` | Per-session lifecycle and cancellation reason |
| `catalog.resource.*` | Shared request count, deduplication, and consumer detach |
| `catalog.deferredMetadata.batch` | Bounded deferred-metadata batch work |
| `storage.cacheScan*` | Scan span, native invocation, JavaScript fallback, and deduplicated callers |

New trace metadata must remain bounded and must not include prompts, message content,
tokens, authorization headers, local paths, model paths, or document contents.

## Deterministic before/after evidence

Mandatory regression tests use call counts, references, bytes, transactions, and processed
characters instead of wall-clock thresholds.

| Area | Earlier cost or risk | Current deterministic proof |
|---|---|---|
| Truncation display | The inference window could be built before the generating-state fast return | 100 patches in a 1,000-message thread add 0 `getThreadInferenceWindow` calls; terminal state adds 1 |
| Attachment preparation | Token counting and final completion could resolve the same retained URI in separate phases | A retained URI is checked once and the completion payload matches the token-counted prepared payload |
| Prompt tokenization | Identical work in a later generation could call the native tokenizer again | Concurrent and settled identical keys produce 1 native count; every context/format/media identity change is a miss |
| Streaming state | Every patch replaced the thread/messages path | 100 patches retain the durable thread, messages array, presentation array, and all 1,000 historical objects |
| Streaming persistence | A streaming flush could sanitize and serialize the full thread | 100 patches produce 0 durable sanitizations, 0 durable stringifications, and 0 durable thread writes; background flush writes 1 bounded progress record |
| Terminal state | Content, metrics, and status could settle through separate mutations | Success/stop/error use 1 store mutation and 1 logical terminal persistence transaction, with stale-ID and idempotency checks |
| Reasoning parsing | Each callback could rescan accumulated output | Delta streams report processed characters exactly equal to total input characters; a snapshot adds its length once |
| Model initialization | Duplicate or known-bad accelerator profiles could be retried | Candidate keys are unique, GPU layers descend, known OOM upper bounds are skipped, and CPU fallback remains |
| Catalog cancellation | Singleton-wide cancellation could abort unrelated screens | Two consumers share one resource call; detaching one leaves the other running; the last detach aborts and all maps/listeners settle empty |
| Cache-size measurement | N concurrent callers could enqueue N full scans | 8 direct bridge callers use 1 native invocation; 6 storage callers use 1 native invocation; 5 JavaScript-fallback callers use 1 filesystem walk |

The fixtures cover 20, 200, and 1,000 historical messages; short and
8K-token-equivalent outputs; reasoning; image, audio, and document history; and model
switch markers.

## Native and measurement limits

- Android performs the actual cache-tree walk on a single native executor, off the
  JavaScript thread. The repository has one production call path through
  `SystemMetricsService`, so an additional native shared-future API is not currently
  required.
- An already-running native filesystem walk cannot be canceled. Generation checks prevent
  its result from becoming current after clear or refresh; a fresh scan may be queued for
  the new generation.
- iOS has no native cache-size method in this module and uses the bounded JavaScript
  fallback.
- Model initialization duration and throughput remain device-, model-, backend-, and
  thermal-state dependent. Do not convert these contracts into fixed timing assertions.
- The in-app trace is bounded diagnostic evidence, not a full native profiler. Use device
  tracing when investigating scheduler, GPU, NPU, filesystem, or thermal behavior.

## Verification

Run the deterministic gates after changing these paths:

```bash
npm run typecheck
npm run lint
npm test
npm run coverage
npm run verify:mobile-change
```

When an Android environment is available, also run the relevant runtime/storage scenario
pack. Keep hard wall-clock thresholds out of required CI; use manual device traces for
timing comparisons.
