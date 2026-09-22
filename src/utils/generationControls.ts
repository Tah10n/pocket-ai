import type { CompletionParams, ChatTemplateKwargs } from 'llama.rn';
import type { StructuredOutputOptions } from './structuredOutput';

// Request-local clock value; it must not turn into an explicit user template
// override merely because a snapshot is serialized and later reused.
const PREPARED_TEMPLATE_NOW: unique symbol = Symbol('preparedTemplateNow');

export interface ChatTemplateSettings {
  chatTemplate?: string;
  jinja?: boolean;
  kwargs?: ChatTemplateKwargs;
  addGenerationPrompt?: boolean;
  /** Unix seconds, held constant for an entire prepared request. */
  now?: string | number;
  forcePureContent?: boolean;
  /** Prompt suffix and parser prefill; reused when already retained from the last assistant continuation. */
  prefillText?: string;
}

/** Optional fields preserve legacy records; native requests always resolve defaults. */
export interface AdvancedGenerationParameters {
  penaltyLastN?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  typicalP?: number;
  mirostat?: 0 | 1 | 2;
  mirostatTau?: number;
  mirostatEta?: number;
  xtcProbability?: number;
  xtcThreshold?: number;
  dryMultiplier?: number;
  dryBase?: number;
  dryAllowedLength?: number;
  dryPenaltyLastN?: number;
  drySequenceBreakers?: string[];
  topNSigma?: number;
  stop?: string[];
  ignoreEos?: boolean;
  logitBias?: [number, number][];
  nProbs?: number;
  reasoningFormat?: 'none' | 'auto' | 'deepseek';
  thinkingBudgetTokens?: number;
  thinkingBudgetMessage?: string;
  template?: ChatTemplateSettings;
  output?: StructuredOutputOptions;
}

// These are product safety bounds, not a claim that upstream enforces ranges.
export const ADVANCED_GENERATION_RANGES = {
  penaltyLastN: [-1, 131072, true],
  frequencyPenalty: [-2, 2, false],
  presencePenalty: [-2, 2, false],
  typicalP: [0, 1, false],
  mirostatTau: [0, 20, false],
  mirostatEta: [0, 1, false],
  xtcProbability: [0, 1, false],
  xtcThreshold: [0, 1, false],
  dryMultiplier: [0, 10, false],
  dryBase: [1, 10, false],
  dryAllowedLength: [0, 256, true],
  dryPenaltyLastN: [-1, 131072, true],
  topNSigma: [-1, 20, false],
  nProbs: [0, 10, true],
  thinkingBudgetTokens: [0, 8192, true],
} as const;

export const ADVANCED_GENERATION_KEYS: readonly (keyof AdvancedGenerationParameters)[] = [
  ...Object.keys(ADVANCED_GENERATION_RANGES) as (keyof typeof ADVANCED_GENERATION_RANGES)[],
  'mirostat', 'ignoreEos', 'stop', 'drySequenceBreakers', 'logitBias', 'reasoningFormat',
  'thinkingBudgetMessage', 'template', 'output',
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 32
    || !value.every((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256)) {
    return undefined;
  }
  // Whitespace is significant in stop strings and DRY breakers.
  return [...value];
}

export function sanitizeChatTemplate(value: unknown): ChatTemplateSettings | undefined {
  const input = record(value);
  if (!input) return undefined;
  const result: ChatTemplateSettings = {};
  for (const key of ['chatTemplate', 'prefillText'] as const) {
    if (typeof input[key] === 'string' && input[key].length <= 32768) result[key] = input[key];
  }
  for (const key of ['jinja', 'addGenerationPrompt', 'forcePureContent'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (typeof input.now === 'number' && Number.isFinite(input.now) && input.now >= 0
    && input.now <= 253402300799) result.now = input.now;
  if (typeof input.now === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(input.now)
    && Number(input.now) <= 253402300799) result.now = input.now;
  const kwargs = record(input.kwargs);
  if (kwargs && Object.keys(kwargs).length <= 32) {
    const entries = Object.entries(kwargs);
    if (entries.every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)
      && !['__proto__', 'constructor', 'prototype'].includes(key)
      && (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
        || (typeof item === 'string' && item.length <= 4096)))) {
      result.kwargs = Object.fromEntries(entries) as ChatTemplateKwargs;
    }
  }
  return result;
}

export function sanitizeAdvancedGenerationParameters(value: unknown): AdvancedGenerationParameters {
  const input = record(value);
  if (!input) return {};
  const result: AdvancedGenerationParameters = {};
  for (const key of Object.keys(ADVANCED_GENERATION_RANGES) as (keyof typeof ADVANCED_GENERATION_RANGES)[]) {
    const number = input[key];
    const [min, max, integer] = ADVANCED_GENERATION_RANGES[key];
    if (typeof number === 'number' && Number.isFinite(number)) {
      result[key] = Math.max(min, Math.min(max, integer ? Math.round(number) : number));
    }
  }
  if (input.mirostat === 0 || input.mirostat === 1 || input.mirostat === 2) result.mirostat = input.mirostat;
  if (typeof input.ignoreEos === 'boolean') result.ignoreEos = input.ignoreEos;
  for (const key of ['stop', 'drySequenceBreakers'] as const) {
    const strings = boundedStrings(input[key]);
    if (strings !== undefined) result[key] = strings;
  }
  if (Array.isArray(input.logitBias) && input.logitBias.length <= 128
    && input.logitBias.every((pair): pair is [number, number] => Array.isArray(pair) && pair.length === 2
      && Number.isInteger(pair[0]) && pair[0] >= 0 && pair[0] <= 2147483647
      && typeof pair[1] === 'number' && Number.isFinite(pair[1]) && Math.abs(pair[1]) <= 100)) {
    result.logitBias = input.logitBias.map(([token, bias]) => [token, bias]);
  }
  if (input.reasoningFormat === 'none' || input.reasoningFormat === 'auto' || input.reasoningFormat === 'deepseek') {
    result.reasoningFormat = input.reasoningFormat;
  }
  if (typeof input.thinkingBudgetMessage === 'string' && input.thinkingBudgetMessage.length <= 1024) {
    result.thinkingBudgetMessage = input.thinkingBudgetMessage;
  }
  const template = sanitizeChatTemplate(input.template);
  if (template !== undefined) result.template = template;
  const output = record(input.output);
  if (output?.mode === 'text' || output?.mode === 'json_object') result.output = { mode: output.mode };
  // Keep bounded invalid drafts for editing; strict schema/grammar checks happen before native work.
  if (output?.mode === 'json_schema') {
    result.output = { mode: 'json_schema', schema: typeof output.schema === 'string' && output.schema.length <= 32768 ? output.schema : '' };
  }
  if (output?.mode === 'gbnf') {
    result.output = { mode: 'gbnf', grammar: typeof output.grammar === 'string' && output.grammar.length <= 32768 ? output.grammar : '' };
  }
  return result;
}

export type SamplingRequest = Pick<CompletionParams,
  'penalty_last_n' | 'penalty_freq' | 'penalty_present' | 'typical_p' | 'mirostat' | 'mirostat_tau'
  | 'mirostat_eta' | 'xtc_probability' | 'xtc_threshold' | 'dry_multiplier' | 'dry_base'
  | 'dry_allowed_length' | 'dry_penalty_last_n' | 'dry_sequence_breakers' | 'top_n_sigma'
  | 'ignore_eos' | 'logit_bias' | 'n_probs' | 'thinking_budget_message'>;

export function resolveAdvancedSampling(input: AdvancedGenerationParameters): SamplingRequest {
  const params = sanitizeAdvancedGenerationParameters(input);
  // rc.3 JSIParams indexes a cleared std::vector here. Never enter that native path.
  if (params.ignoreEos === true || (params.logitBias?.length ?? 0) > 0) {
    throw new Error('This runtime cannot safely apply ignore_eos or nonempty logit_bias.');
  }
  // The native sampler reuses previous values for omitted fields. Reset every field
  // on every request so another chat cannot inherit probabilities or samplers.
  return {
    penalty_last_n: params.penaltyLastN ?? 64,
    penalty_freq: params.frequencyPenalty ?? 0,
    penalty_present: params.presencePenalty ?? 0,
    typical_p: params.typicalP ?? 1,
    mirostat: params.mirostat ?? 0,
    mirostat_tau: params.mirostatTau ?? 5,
    mirostat_eta: params.mirostatEta ?? 0.1,
    xtc_probability: params.xtcProbability ?? 0,
    xtc_threshold: params.xtcThreshold ?? 0.1,
    dry_multiplier: params.dryMultiplier ?? 0,
    dry_base: params.dryBase ?? 1.75,
    dry_allowed_length: params.dryAllowedLength ?? 2,
    dry_penalty_last_n: params.dryPenaltyLastN ?? -1,
    dry_sequence_breakers: [...(params.drySequenceBreakers ?? ['\n', ':', '"', '*'])],
    top_n_sigma: params.topNSigma ?? -1,
    ignore_eos: false,
    logit_bias: [],
    n_probs: params.nProbs ?? 0,
    thinking_budget_message: params.thinkingBudgetMessage ?? '',
  } satisfies SamplingRequest;
}

export function advancedGenerationIdentity(value: unknown): string {
  return JSON.stringify(sanitizeAdvancedGenerationParameters(value));
}

/** Freeze time before context selection and carry it through every retry. */
export function freezeGenerationParameters(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): AdvancedGenerationParameters & { readonly [PREPARED_TEMPLATE_NOW]: string | number } {
  const generation = sanitizeAdvancedGenerationParameters(value);
  const previousNow = typeof value === 'object' && value !== null && PREPARED_TEMPLATE_NOW in value
    ? value[PREPARED_TEMPLATE_NOW] : undefined;
  return { ...generation, [PREPARED_TEMPLATE_NOW]: generation.template?.now
    ?? (typeof previousNow === 'number' || typeof previousNow === 'string' ? previousNow : nowSeconds) };
}

export function getPreparedTemplateNow(value: AdvancedGenerationParameters): string | number | undefined {
  const prepared = PREPARED_TEMPLATE_NOW in value ? value[PREPARED_TEMPLATE_NOW] : undefined;
  return value.template?.now ?? (typeof prepared === 'string' || typeof prepared === 'number' ? prepared : undefined);
}

export function generationFormattingIdentity(value: unknown): string {
  const { template, output } = sanitizeAdvancedGenerationParameters(value);
  const preparedNow = typeof value === 'object' && value !== null && PREPARED_TEMPLATE_NOW in value
    ? value[PREPARED_TEMPLATE_NOW] : undefined;
  return JSON.stringify({ template, output, preparedNow: template?.now ?? preparedNow });
}
