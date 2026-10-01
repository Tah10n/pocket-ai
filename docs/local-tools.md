# Local tools

Local tools let a compatible on-device model request a small set of functions and
use their results in its next response. Enable them explicitly in the current
chat's **Local tools** control, open **Available tools**, then send a request. Existing
chats keep tools off by default. No confirmation is needed for each calculation.

[Android CPU native acceptance](llama-rn-013-stage4-acceptance.md) verifies required calculator execution, attached-document search, structured final output, Stop recovery and cold reopen on the pinned Qwen fixture. Automatic calculator selection was observed with zero native calls; ordinary JSON was correctly not executed. This does not establish compatibility for every model, platform or document format.

## Available functions

| Function | Input and result |
| --- | --- |
| `calculate` | Decimal arithmetic using `+`, `-`, `*`, `/`, unary signs and parentheses. Returns a finite device-number result. Division by zero, overflow and unsupported syntax return errors. No JavaScript, shell, `eval` or executable expressions. |
| `get_current_datetime` | Device time with its actual timezone or an explicitly requested supported zone. Returns timezone/offset information; an invalid zone is an error rather than a silent substitution. No network clock. |
| `search_attached_documents` | Searches up to four ready document attachments committed to the current chat using its selected Keywords/Hybrid mode and optional local reranking. Optional document IDs narrow the owned set. Returns bounded untrusted excerpts with original document/chunk IDs, real available locators, and the actual retrieval mode/fallback reason when an auxiliary mode was requested. Empty matches are valid. |

Document IDs, current-chat ownership, attachment identity and availability are checked before reading, after asynchronous work and before returning results. Search shares `DocumentRetrievalService` with ordinary document context and editing/regeneration. Keywords preserves lexical filtering; Hybrid can return a semantically selected paraphrase even when it shares no query word. The model's proposed IDs never grant access to another chat or arbitrary file.

Choose the chat's **Document search** options independently from **Local tools** permissions. Select exact compatible auxiliary models in Models, then prepare owned documents explicitly or through an ordinary document request. The tool reads compatible prepared vectors after restart and embeds only its current query. It passes `prepareMissing: false`: missing or stale indexes use explicit safe Keywords fallback where allowed, rather than creating cold embeddings inside the tool's ten-second deadline. Local reranking can also run on Keywords candidates without an embedding model.

Requested and actual mode are separate. Auxiliary results include `retrievalMode` and an optional bounded `fallbackReason`; a Hybrid request that used Keywords is not a successful embedding result. Stop, changed ownership, unknown native drain and failed A restoration cannot return a hidden lexical result or start the next model completion.

Returned text remains untrusted source data. Documents cannot register functions, alter schemas or grant new permissions. The static allowlist, fixed argument schemas, result-byte budget, sequential execution and independent final-output validation are unchanged. No new arbitrary filesystem, network, shell, catalog or private-settings tool is introduced.

## Settings, output and progress

Permissions and allowed functions are captured at the start of one user request.
The live permissions must still authorize each call. The chat toggle enables the three built-ins with automatic choice, so the model
may answer without a tool. The internal `required` mode, used for controlled
acceptance, applies only to the first selection step; later steps return to
automatic choice. It is not a separate user-facing toggle.

The message shows requested, running, completed, error or cancelled calls in a
collapsible view. A proposed call is not an executed call. Intermediate stream
arguments can be incomplete and never trigger execution. Only final native parsed
calls with complete validated arguments can execute, sequentially. Interrupted,
truncated, context-full or token-limited proposals are rejected. Ordinary assistant
JSON with similar field names is never interpreted as an action.

Selection steps retain the formatter's tool grammar and parser. A configured JSON,
JSON Schema or GBNF final response uses a separate final phase with tool choice
`none` and the existing output validation. Text with a configured content prefill
also uses this final phase so the prefix is preserved without corrupting tool parsing. Immutable definitions remain available
to render the same tool-aware history template. No final-phase call executes, and
invalid or incomplete structured output is not marked successful. Custom GBNF with
content prefill remains unsupported. Original image/audio attachments remain in
the history for subsequent steps; media requests still disable MTP.

Stop cancels the whole run, including gaps between native completions. Chat/model/
LoRA changes, revoked permissions, document removal and private-data clearing
invalidate the run. Late results cannot continue it. A timeout requests cancellation;
resources remain owned until actual native/document work settles. An ordinary new
request can proceed after that work drains. Tool errors return bounded structured
categories when continuation is safe; exhausted budgets terminate without hidden
retries.

After native work settles, an interrupted ordinary reply keeps its parsed user
content and a stopped/error status. Raw protocol text is not a partial-answer
fallback. Incomplete tool proposals cannot execute, and incomplete or invalid
constrained output cannot become successful. Results from invalidated ownership
are discarded.

## Retrieval ownership and deadlines

The genuine `LocalToolRun` engine lease spans the native proposal, document retrieval and result-to-model continuation. A is temporarily suspended while Hybrid uses embedding B and optional reranker C sequentially; Keywords with reranking uses only C. Selection/permission ownership remains valid during that suspension; full native readiness is required again before continuation. Verified internal restoration updates the lease's context epoch only after the same actual A profile, ordered LoRA bindings/scales and companion identity are restored. A user-provided or model-generated owner token is never accepted.

The existing limits remain **180 seconds per run and ten seconds per tool**, plus byte/token/context limits. Explicit document preparation has its own bounded preparation budget and does not enlarge tool deadlines. A deadline requests cancellation and blocks further calls/completions; it is not proof that native memory or an opaque document source was released. Ownership stays retained through the real callback, including tokenization, source enumeration and the complete in-flight rerank batch. rc.3 exposes no operation-wide embedding/rerank cancellation API, so Stop cannot release that batch early. Stop after confirmed drain may restore the unchanged A selection for the next request; changed selection/private-storage/document ownership cannot restore stale A or publish late results. Uncertain drain requires engine recovery or process restart.

Completed call/result history remains encrypted and never reexecutes on hydration. [Stage 5 Android CPU acceptance](llama-rn-013-stage5-acceptance.md) verified genuine Hybrid feedback with reranking off, committed history and constrained final output with 641 prompt/native evaluated tokens under the unchanged ten-second deadline. Cold vector reuse and pre-native stale-ID rejection after deletion also passed. Separate corpus and LoRA cases establish C execution; Tool+C continuation within that deadline remains unverified. Ordinary control verification is recorded separately.

## Limits

The shared run limits live in `src/services/LocalToolLimits.ts`; arithmetic limits
live in `src/services/LocalToolBuiltins.ts`.

| Resource | Maximum |
| --- | --- |
| Tool rounds / total calls | 4 / 8 per user request |
| Arguments / one result / all results | 4,096 / 8,192 / 32,768 UTF-8 bytes |
| Run / individual tool deadline | 180 / 10 seconds |
| Generated tokens across completions | Smaller of the request's token limit and 4,096 (default request limit 512) |
| Prompt plus generated tokens across completions | 32,768, also bounded by the loaded context with a 16-token reserve |
| Search query / selected documents | 256 characters / 4 |
| Search matches / excerpt | 4 / 1,200 characters |
| Document file | 10 MiB |
| Arithmetic expression / operations / depth | 512 characters / 64 / 16 |
| Timezone name | 128 characters |

Repeated native IDs cannot execute twice; conflicting reuse is rejected. Missing
IDs receive deterministic IDs within the run. Different calls are not deduplicated
merely because their arguments match.

## History and compatibility

One typed protocol record links each assistant proposal to its result and execution
status. It follows encrypted chat persistence, branching, regeneration and private
storage clearing. Reopening history never executes old calls; an unfinished saved
run becomes interrupted. Regenerate starts a new run. Context preparation preserves
complete call/result groups and reports insufficient space instead of cutting an
argument or leaving an orphan result.

Regeneration and early-branch replacement retain the previous history until
meaningful output exists. An empty run envelope does not commit a replacement:
early Stop/error and cold recovery restore the original branch and attachment
owners. Actual parsed content and tool call/result records remain recoverable
without reexecution.

The pinned runtime remains **llama.rn 0.13.0-rc.3**. Its implemented `tool_choice`
values are exactly `auto`, `none` and `required`; named-function strings and provider
object forms are unsupported. Its public formatter incorrectly serializes
`parallel_tool_calls` to a string while JSI reads a strict boolean. The app omits
that option, preserving the effective native default **false**. Multiple returned
calls are handled sequentially. This is independent of `context.parallel`, which
remains disabled.

A compatible loaded Jinja template must support tools and tool calls and produce
usable native parser metadata. Specialized handlers and compatible differential
autoparsers are eligible; the presence of Jinja alone is insufficient. Custom
template overrides, pure-content forcing and legacy templates are rejected for
tool execution. History opened with tools disabled also requires its selected
default template to preserve the protocol; unsupported history is a clear error.
These checks establish formatting eligibility, not that a particular GGUF can
reliably choose and use functions.

The package README advertises an older `GENERIC` fallback with a
`{"response":"..."}` wrapper. The installed rc.3 implementation instead has
content-only and PEG formats, specialized handlers and a differential autoparser;
it contains no such generic fallback. The app does not reproduce that obsolete
contract or unwrap arbitrary assistant JSON. Only native parsed content is shown
from tool-selection output.

Technical diagnostics may contain function names, counts, durations, sizes and
error categories, but not arguments, document results, prompts, generated text or
reconstructible token sequences. Local protocol history remains protected by the
existing private-storage controls. See the [runtime inventory](llama-rn-capabilities.md)
and [source patch](validation/llama-rn-stage3/native-probability-patch.md) for the
implementation and verification boundaries.
