# Bounded llama requests

Pocket AI uses the official **llama.rn 0.13.0-rc.3** queue for eligible ordinary
text completions and document embeddings/reranking. Ordinary operation stays at
one slot. **Compare two answers** explicitly requests two bounded alternatives
from the same model for the latest text turn. It does not load two models.

## Compare two answers

The chat control captures one history snapshot and two generation configurations.
Temperature and seed distinguish the alternatives without changing saved global
settings. Each variant has its own status and Stop action. Only **Use this answer**
commits a result through the existing history replacement transaction. Closing the
panel preserves the previous answer and branch. Results are process-local; restart
does not resume a comparison or execute a saved tool call.

The first comparison profile supports CPU text models with known llama/qwen2/qwen3
metadata and a verified memory budget. Tools, document retrieval, audio/vision,
speech and speculative decoding use their existing exclusive paths. The control
explains incompatible chat contents. Unsupported or insufficient-memory profiles
retain ordinary sequential chat; comparison does not silently change the selected
model, backend, adapters or output constraint.

Explicit prefill (`n_predict: 0`) keeps the exclusive completion path because the
rc.3 queued decoder does not preserve its zero-output semantics.

Both requests use `PreparedLlamaRequest`, including one frozen clock, grammar/schema,
parser metadata, prefill and stops. Both exact formatted token counts are computed
before either native request starts. Each prompt plus its bounded output and reserve
must fit its own context. JSON constraints are validated independently. Custom GBNF
uses native grammar enforcement; interrupted or truncated output is not proof of a
complete grammar result. No second formatter or network service is involved.

## Context and memory

There is still one heavy `LlamaContext`. The existing auxiliary sequence owner
captures A's effective load profile and ordered LoRA bindings, releases A, loads a
temporary same-model comparison context, drains it and restores A. Selection and
private-storage changes invalidate publication and stale restoration.

In rc.3, load-time `n_parallel` reserves the maximum sequence capacity. Enabling
two slots on a context loaded for one is unsupported. The slot manager divides
actual total `n_ctx` by enabled slots. Comparison therefore requests twice the
ordinary per-request context allocation: a 4096-token profile requests 8192 total
tokens for two 4096-token requests. It does not relabel 2048 tokens as 4096.

The transient profile keeps the same context-wide backend, KV types, batch/ubatch,
threads and LoRA settings, with context shifting disabled. Memory admission counts
the full model, adapter, KV, compute and safety estimates plus concurrent
sampler/parser/result reserves. Unknown or insufficient fit rejects comparison.
Batch and microbatch are each limited to 512 for the initial comparison profile;
their activation and staging reserves are counted separately from KV memory.
Its slot count, total/per-request context and allocation policy are recorded in
comparison diagnostics and request profile identity. This allocation does not
read or write single-slot calibration or last-good records; restored A retains
its ordinary profile. Two-slot fit is not inferred from one-slot success.

`state_cache_budget_mb` remains **0** and `state_cache_max_checkpoints` remains **8**.
Session save/load, prompt-state caching, background chat generation and a model
pool are outside this implementation.

## Request ownership and cancellation

`LlamaParallelRequests` is bounded ownership accounting around the official queue,
not an additional scheduler. It accepts at most six jobs; native capacity is at
most two slots. Each completion captures an app ID, owner, model/file identity,
context epoch, effective profile identity and prepared prompt/output snapshot.
Callbacks close over that request before admission begins. They never route to
whichever chat happens to be active.

The outer Promise returns a native handle; the handle's inner Promise represents
the eventual result. Callbacks can arrive before the outer Promise resolves.
Repeated app IDs reuse the same active operation only when the complete snapshot
matches. An admission failure retains its reservation until native status confirms
the observed request has left the worker, or the whole queue is idle when no ID
was delivered. JSI can fail to deliver a handle after enqueueing work. Native IDs are
scoped to the captured context/epoch.

States distinguish admission, queueing, native execution, cancelling and terminal
completed/cancelled/error outcomes. Repeated terminal or late token/status events
cannot republish an answer. Stop before admission records intent and calls the
returned handle's `stop()` as soon as its ID becomes available. Stop acknowledgement
is not settlement. A queued cancellation cannot start later; running Stop targets
one request and leaves its neighboring slot alone.

Ownership remains until both the result settles and a native status barrier proves
the request has left the worker. The guarded native patch counts DONE slots as
occupied until reset; a terminal callback alone can precede that reset. Conversely,
disappearance from status without a terminal result is not a drain receipt.
Unknown drain remains subject to the engine's recovery quarantine. No timeout is
used as permission to release a model, adapter, projector, codec or file.
Ordinary queued text also has a 120-second inactivity watchdog, renewed by native
tokens. A missing Stop acknowledgement is bounded at the caller while its actual
pending operation remains owned; neither watchdog enables early unload or retry.

Enable/configure/disable are permitted only under the existing exclusive engine
owner at a confirmed idle boundary. Subscriptions acquired after their owner is
invalidated are removed immediately, and callbacks remain owner-guarded after
unsubscription. Global unload/reset/background handling stops all requests owned
by its generation and drains the aggregate; a variant's Stop remains individual.

## Document retrieval

`DocumentRetrievalRuntime` enables one slot per auxiliary context and issues one
accepted job at a time through `parallel.embedding` and `parallel.rerank`. B and C
remain sequential under the same A+LoRA → B → C → A owner, including local-tool
handoffs. Source/chunk identity, finite/unit-vector checks, original rerank indexes,
document correspondence and atomic index publication remain enforced.

Embedding/rerank handles have no public `stop()`. Cancellation stops issuing new
jobs, suppresses the cancelled result and waits for accepted jobs to settle before
releasing the auxiliary context or restoring A. It never calls `stopCompletion`
as a generic auxiliary cancellation API, nor retries an already-started job through
the old API.

E5 keeps mean pooling and L2 normalization (`embd_normalize: 2`). Queued BGE scoring
keeps raw rank-pooling `data[0]`; rc.3 stores `normalize` but does not apply it.
The app explicitly passes `normalize: -1`, preserves raw-score meaning and rejects
the native failed-pair sentinel. Chunking, ranking fusion and index schema are
unchanged. The existing source-patch fingerprint invalidates indexes produced by
an incompatible runtime patch.

## Pinned upstream corrections and evidence

The version/hash-guarded patch fixes queued auxiliary errors that otherwise free
the native slot while leaving the JS result Promise pending. Typed terminal error
payloads reject the inner Promise, including errors arriving before admission.
Per-slot initialization/sampler failures terminate their owner; a shared batch
decode failure correctly fails every affected slot. Queue logs omit tokens,
stopping words, embeddings and private paths. These source changes require a new
native binary; JavaScript tests are not inference evidence.

Contract sources: [JS wrappers](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts),
[types](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/types.ts),
[JSI admission and callbacks](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/jsi/RNLlamaJSI.cpp),
[slot manager](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/rn-slot-manager.cpp)
and [context configuration](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/rn-llama.cpp).

Native acceptance must report one-slot queue/Stop/retry, two-slot execution overlap,
isolated callbacks/results, individual Stop, ordinary UI selection, queued B/C and
A+LoRA restoration separately. Two unsettled JS Promises do not prove parallel
decode. Sequential/two-slot time, TTFT and memory measurements establish observations,
not a promised speedup. Source commit, APK identity, hosted CI and actual inference
receipts remain separate evidence categories.
