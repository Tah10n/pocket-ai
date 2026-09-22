import type { CompletionParams, JinjaFormattedChatResult, LlamaContext } from 'llama.rn';
import type { LlmChatMessage } from '../types/chat';
import { getPreparedTemplateNow, type AdvancedGenerationParameters } from '../utils/generationControls';
import { prepareStructuredOutput, type PreparedStructuredOutput } from '../utils/structuredOutput';
import {
  getFormattedChatFromContext, type LlamaChatFormatOptions, type LlamaFormattedChatResult,
} from './LlamaRuntimeAdapter';

export type PreparedCompletionParams = CompletionParams
  & Pick<JinjaFormattedChatResult, 'thinking_start_tag' | 'thinking_end_tag'>;

export type PreparedLlamaRequest = {
  formatted: LlamaFormattedChatResult;
  output: PreparedStructuredOutput;
  completion: PreparedCompletionParams;
};

const MAX_CACHE_ENTRIES = 8;
const MAX_CACHE_CHARS = 512 * 1024;

function pureContentParsing(generationPrompt: string): Pick<PreparedCompletionParams,
  'generation_prompt' | 'prefill_text' | 'chat_parser' | 'chat_format'
  | 'thinking_forced_open' | 'thinking_start_tag' | 'thinking_end_tag'> {
  return {
    generation_prompt: generationPrompt, prefill_text: '', chat_parser: '', chat_format: 0,
    thinking_forced_open: false, thinking_start_tag: '', thinking_end_tag: '',
  };
}

/** Owned by the engine; all calls remain under its native operation reservation. */
export class PreparedLlamaRequestCache {
  private context: LlamaContext | null = null;
  private epoch: number | null = null;
  private cache = new Map<string, { prepared: PreparedLlamaRequest; chars: number }>();
  private chars = 0;

  clear(): void {
    this.context = null;
    this.epoch = null;
    this.cache.clear();
    this.chars = 0;
  }

  async prepare({ context, epoch, messages, generation, enableThinking, reasoningFormat, addGenerationPrompt }: {
    context: LlamaContext;
    epoch: number;
    messages: LlmChatMessage[];
    generation: AdvancedGenerationParameters;
    enableThinking: boolean;
    reasoningFormat: 'none' | 'auto' | 'deepseek';
    addGenerationPrompt?: boolean;
  }): Promise<PreparedLlamaRequest> {
    if (this.context !== context || this.epoch !== epoch) {
      this.clear();
      this.context = context;
      this.epoch = epoch;
    }
    const template = generation.template ?? {};
    const output = prepareStructuredOutput(generation.output);
    if (output.mode === 'gbnf' && (template.prefillText?.length ?? 0) > 0) {
      // USER grammars are deliberately not advanced by generation_prompt in
      // this pinned native sampler. Do not claim full-output prefill semantics.
      throw new Error('Custom GBNF cannot be combined with content prefill in this runtime.');
    }
    const effectiveThinking = output.mode === 'text' && enableThinking;
    const effectiveReasoningFormat = output.mode === 'text' ? reasoningFormat : 'none';
    const options: LlamaChatFormatOptions = {
      jinja: template.jinja,
      enable_thinking: effectiveThinking,
      reasoning_format: effectiveReasoningFormat,
      add_generation_prompt: template.addGenerationPrompt ?? addGenerationPrompt ?? true,
      now: getPreparedTemplateNow(generation),
      chat_template_kwargs: template.kwargs,
      force_pure_content: template.forcePureContent,
      ...(output.responseFormat ? { response_format: output.responseFormat } : {}),
    };
    // Private in-memory key; never log it. Full equality avoids hash collisions.
    const key = JSON.stringify([messages, template.chatTemplate ?? null, options, template.prefillText, generation.output]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.prepared;
    }
    const formatted = await getFormattedChatFromContext({
      context, messages, template: template.chatTemplate, options,
    });
    if (formatted.type === 'llama-chat' && (
      template.now !== undefined || options.add_generation_prompt === false
      || template.forcePureContent === true || Object.keys(template.kwargs ?? {}).length > 0
      || (template.chatTemplate !== undefined && template.jinja !== false)
    )) {
      throw new Error('The loaded model formatter cannot apply these template options. A compatible Jinja template is required.');
    }
    const prefill = template.prefillText ?? '';
    const lastMessage = messages.at(-1);
    const lastAssistantText = lastMessage?.role === 'assistant' ? lastMessage.content : undefined;
    // An explicit assistant continuation can already carry the configured
    // prefix. Reuse it only when both history and formatter retained that suffix;
    // a matching user message alone must never suppress the requested prefill.
    const hasAssistantPrefill = prefill.length > 0 && lastAssistantText?.endsWith(prefill)
      && formatted.prompt.endsWith(prefill);
    const completion: PreparedCompletionParams = {
      // Supplying prompt instead of messages avoids upstream formatting again,
      // replacing explicit grammar, mutating stop arrays or choosing another now.
      prompt: formatted.prompt + (hasAssistantPrefill ? '' : prefill),
      prefill_text: prefill,
      jinja: template.jinja,
      enable_thinking: effectiveThinking,
      reasoning_format: effectiveReasoningFormat,
      ...(formatted.has_media ? { media_paths: formatted.media_paths } : {}),
      ...(formatted.chat_format !== undefined ? { chat_format: formatted.chat_format } : {}),
      ...(formatted.grammar !== undefined ? { grammar: formatted.grammar } : {}),
      ...(formatted.grammar_lazy !== undefined ? { grammar_lazy: formatted.grammar_lazy } : {}),
      ...(formatted.grammar_triggers !== undefined ? { grammar_triggers: formatted.grammar_triggers.map((item) => ({ ...item })) } : {}),
      ...(formatted.preserved_tokens !== undefined ? { preserved_tokens: [...formatted.preserved_tokens] } : {}),
      ...(formatted.generation_prompt !== undefined ? { generation_prompt: formatted.generation_prompt } : {}),
      ...(formatted.thinking_forced_open !== undefined ? { thinking_forced_open: formatted.thinking_forced_open } : {}),
      ...(formatted.thinking_start_tag !== undefined ? { thinking_start_tag: formatted.thinking_start_tag } : {}),
      ...(formatted.thinking_end_tag !== undefined ? { thinking_end_tag: formatted.thinking_end_tag } : {}),
      ...(formatted.chat_parser !== undefined ? { chat_parser: formatted.chat_parser } : {}),
      ...(output.responseFormat ? { response_format: output.responseFormat } : {}),
    };
    if (output.mode === 'gbnf') {
      // Explicit user grammar wins over template grammar/schema. Lazy grammar
      // triggers are meaningful only with the grammar that generated them.
      completion.grammar = output.grammar;
      completion.grammar_lazy = false;
      completion.grammar_triggers = [];
      completion.preserved_tokens = [];
      // Native template parsers can consume protocol literals even when reasoning
      // extraction is disabled. An explicit user grammar owns the entire output.
      Object.assign(completion, pureContentParsing(''));
    } else if (output.responseFormat) {
      // Native explicitly gives grammar priority over json_schema. Clear a
      // template grammar so the user's selected schema cannot silently weaken.
      completion.grammar = '';
      completion.json_schema = JSON.stringify(output.schema ?? { type: 'object', additionalProperties: true });
      completion.grammar_lazy = false;
      completion.grammar_triggers = [];
      completion.preserved_tokens = [];
      // rc.3 feeds generation_prompt into OUTPUT_FORMAT grammar AND prepends it
      // to parser input. Assistant protocol framing is not JSON. Use only the
      // content prefix to advance the schema grammar, and the public empty-parser
      // content-only path to reconstruct prefix + generated suffix exactly once.
      // prefill_text would prepend it a second time; retain original formatter
      // metadata separately in prepared.formatted for stops/identity/diagnostics.
      Object.assign(completion, pureContentParsing(prefill));
    }
    const prepared = { formatted, output, completion };
    const chars = key.length + JSON.stringify(prepared).length;
    // A late formatter may settle after cancellation/replacement: do not let it
    // repopulate a cache belonging to another native context.
    if (this.context === context && this.epoch === epoch && chars <= MAX_CACHE_CHARS) {
      while (this.cache.size >= MAX_CACHE_ENTRIES || this.chars + chars > MAX_CACHE_CHARS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.chars -= this.cache.get(oldest)!.chars;
        this.cache.delete(oldest);
      }
      this.cache.set(key, { prepared, chars });
      this.chars += chars;
    }
    return prepared;
  }
}
