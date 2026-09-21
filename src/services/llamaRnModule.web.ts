import { buildLlamaRuntimeDiagnostics, type DiagnosticContext } from './LlamaRuntimeDiagnostics';

export type LlamaModule = typeof import('llama.rn');

export function getLlamaRuntimeDiagnostics(_context: DiagnosticContext | null = null) {
  return buildLlamaRuntimeDiagnostics(null, 'unavailable_on_web', null);
}

export function requireLlamaModule(): LlamaModule {
  throw new Error('[LLMEngine] llama.rn is not available on web builds');
}
