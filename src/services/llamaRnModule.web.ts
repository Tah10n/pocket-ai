export type LlamaModule = typeof import('llama.rn');

export function requireLlamaModule(): LlamaModule {
  throw new Error('[LLMEngine] llama.rn is not available on web builds');
}
