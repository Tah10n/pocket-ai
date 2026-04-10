export type LlamaModule = typeof import('llama.rn');

let llamaModule: LlamaModule | null = null;
let llamaModuleLoadError: Error | null = null;

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

