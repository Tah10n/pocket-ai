import { buildLlamaRuntimeDiagnostics, type DiagnosticContext } from './LlamaRuntimeDiagnostics';

export type LlamaModule = typeof import('llama.rn');

let llamaModule: LlamaModule | null = null;
let llamaModuleLoadError: Error | null = null;

/** Observes cached JS exports and the active context only; never loads the module or installs JSI. */
export function getLlamaRuntimeDiagnostics(context: DiagnosticContext | null = null) {
  return buildLlamaRuntimeDiagnostics(
    llamaModule,
    llamaModule ? 'loaded' : llamaModuleLoadError ? 'load_failed' : 'not_loaded',
    context,
  );
}

export function requireLlamaModule(): LlamaModule {
  if (llamaModule) {
    return llamaModule;
  }

  if (llamaModuleLoadError) {
    throw llamaModuleLoadError;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    llamaModule = require('llama.rn') as LlamaModule;
    return llamaModule;
  } catch (error) {
    llamaModuleLoadError = error instanceof Error ? error : new Error(String(error));
    throw llamaModuleLoadError;
  }
}
