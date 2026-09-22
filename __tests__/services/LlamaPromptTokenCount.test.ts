import { getCompletionPromptTokenCount } from '../../src/services/LlamaPromptTokenCount';

function count(metadata: Record<string, unknown>, hasMedia = false) {
  const context = { model: { metadata } };
  return getCompletionPromptTokenCount(context, { tokens: [10, 20, 30], has_media: hasMedia });
}

describe('pinned native completion special-token counting', () => {
  it.each([
    ['llama', 'llama', undefined, 4],
    ['gpt2', 'qwen2', 'qwen2', 3],
    ['gpt2', 'llama', 'llama-bpe', 4],
    ['gpt2', 'mistral3', 'tekken', 4],
    ['t5', 't5', undefined, 4],
    ['bert', 'bert', undefined, 5],
    ['rwkv', 'rwkv6', undefined, 3],
    ['plamo2', 'plamo2', undefined, 3],
    ['gemma4', 'gemma4', undefined, 4],
  ])('mirrors %s / %s / %s defaults without adding text to prompt', (tokenizer, architecture, pre, expected) => {
    expect(count({ 'tokenizer.ggml.model': tokenizer, 'general.architecture': architecture, 'tokenizer.ggml.pre': pre })).toBe(expected);
  });

  it('honors explicit false, and counts EOS only when completion enables add_special', () => {
    const metadata = { 'general.architecture': 'llama', 'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.add_eos_token': 'true' };
    expect(count(metadata)).toBe(5);
    expect(count({ ...metadata, 'tokenizer.ggml.add_bos_token': 'false' })).toBe(3);
    expect(count({ ...metadata, 'tokenizer.ggml.add_bos_token': false })).toBe(3);
  });

  it('honors the native Gemma4 override of explicit false', () => {
    expect(count({ 'general.architecture': 'gemma4', 'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'gemma4', 'tokenizer.ggml.add_bos_token': false })).toBe(4);
  });

  it('does not add specials a second time to media tokenization', () => {
    expect(count({}, true)).toBe(3);
  });

  it('refuses to label unknown or malformed metadata as exact', () => {
    expect(() => count({})).toThrow('requires tokenizer metadata');
    expect(() => count({ 'general.architecture': 'x', 'tokenizer.ggml.model': 'new-tokenizer' })).toThrow('unavailable');
    expect(() => count({ 'general.architecture': 'llama', 'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.add_bos_token': 'no' })).toThrow('valid tokenizer metadata');
  });
});
