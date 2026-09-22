import type { NativeTokenizeResult } from 'llama.rn';

// Pinned 0.13.0-rc.3: rn-llama.cpp tokenizes text with add_special=false;
// rn-completion.cpp uses add_bos || llama_model_has_encoder instead. Mirror only
// the special-token insertion from llama-vocab.cpp, never guess from filenames.
const BPE_BOS_DEFAULTS = new Set([
  'llama3', 'llama-v3', 'llama-bpe', 'falcon3', 'falcon-h1', 'pixtral',
  'midm-2.0', 'lfm2', 'jina-v5-nano', 'tekken', 'chameleon',
]);
const ENCODERS = new Set(['t5', 't5encoder', 'eagle3', 'dflash']);

function booleanMetadata(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('[LLMEngine] Exact prompt count requires valid tokenizer metadata');
}

export function getCompletionPromptTokenCount(
  context: { model?: { metadata?: unknown } },
  tokenized: Pick<NativeTokenizeResult, 'tokens' | 'has_media'>,
): number {
  // Both media paths call tokenizeWithMedia; it already includes native specials.
  if (tokenized.has_media) return tokenized.tokens.length;
  const metadata: unknown = context.model?.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('[LLMEngine] Exact prompt count requires tokenizer metadata');
  }
  const values = metadata as Record<string, unknown>;
  const tokenizer = values['tokenizer.ggml.model'];
  const architecture = values['general.architecture'];
  const pre = values['tokenizer.ggml.pre'];
  if (typeof tokenizer !== 'string' || typeof architecture !== 'string') {
    throw new Error('[LLMEngine] Exact prompt count requires tokenizer metadata');
  }
  const isBpe = ['gpt2', 'hybriddna', 'whitespace', 'gemma4'].includes(tokenizer);
  if (!isBpe && !['llama', 'bert', 't5', 'rwkv', 'plamo2'].includes(tokenizer)) {
    throw new Error('[LLMEngine] Exact prompt count is unavailable for this tokenizer');
  }
  // These tokenizers ignore add_special entirely in this pinned runtime.
  if (tokenizer === 'rwkv' || tokenizer === 'plamo2') return tokenized.tokens.length;
  const defaultBos = tokenizer === 'llama' || tokenizer === 'bert'
    || (isBpe && typeof pre === 'string' && BPE_BOS_DEFAULTS.has(pre));
  let addBos = booleanMetadata(values['tokenizer.ggml.add_bos_token'], defaultBos);
  const addEos = booleanMetadata(values['tokenizer.ggml.add_eos_token'], tokenizer === 't5');
  // Native overrides even explicit false for the GEMMA4 pre-tokenizer.
  if (tokenizer === 'gemma4' || (isBpe && (pre === 'gemma4' || pre === 'granite-embed-multi-311m'))) {
    addBos = true;
  }
  if (!addBos && !ENCODERS.has(architecture)) return tokenized.tokens.length;
  // WPM adds CLS + SEP whenever add_special is set, independently of add_eos.
  const additionalTokens = tokenizer === 'bert' ? 2 : Number(addBos) + Number(addEos);
  return tokenized.tokens.length + additionalTokens;
}
