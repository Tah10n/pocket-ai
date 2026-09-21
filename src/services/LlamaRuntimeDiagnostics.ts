import type { LlamaContext } from 'llama.rn';
import appPackageJson from '../../package.json';
import type { LlamaRuntimeDiagnostics } from '../types/models';
import type { LlamaModule } from './llamaRnModule';

// These are the methods the app currently uses, not a registry of runtime capabilities.
const moduleMethods = [
  'initLlama', 'loadLlamaModelInfo', 'getBackendDevicesInfo',
  'addNativeLogListener', 'toggleNativeLog', 'releaseAllLlama',
] as const satisfies readonly (keyof LlamaModule)[];
const contextMethods = [
  'getFormattedChat', 'completion', 'tokenize', 'stopCompletion', 'release',
  'initMultimodal', 'getMultimodalSupport', 'releaseMultimodal',
] as const satisfies readonly (keyof LlamaContext)[];

export type DiagnosticContext = Partial<Pick<LlamaContext, typeof contextMethods[number]>>;

export function buildLlamaRuntimeDiagnostics(
  module: LlamaModule | null,
  moduleLoadState: LlamaRuntimeDiagnostics['moduleLoadState'],
  context: DiagnosticContext | null,
): LlamaRuntimeDiagnostics {
  const missingModuleMethods = moduleMethods.filter((name) => typeof module?.[name] !== 'function');
  const missingContextMethods = contextMethods.filter((name) => typeof context?.[name] !== 'function');
  const buildInfo = module?.BuildInfo;
  // Only the public numeric build and hex commit are diagnostic identity. Never copy arbitrary fields.
  const number = typeof buildInfo?.number === 'string' && /^\d{1,20}$/.test(buildInfo.number)
    ? buildInfo.number : undefined;
  const commit = typeof buildInfo?.commit === 'string' && /^[a-f\d]{7,40}$/i.test(buildInfo.commit)
    ? buildInfo.commit : undefined;
  return {
    packageVersion: appPackageJson.dependencies['llama.rn'],
    moduleLoadState,
    buildInfoSource: 'js_package',
    buildInfo: number || commit ? { number, commit } : undefined,
    // JS BuildInfo does not attest to the embedded binary. Native smoke/provenance is separate.
    nativeBinaryVersion: 'unverified',
    moduleApiShape: module
      ? { status: missingModuleMethods.length ? 'missing_methods' : 'available', missingMethods: missingModuleMethods }
      : { status: 'not_checked', missingMethods: [] },
    activeContextApiShape: context
      ? { status: missingContextMethods.length ? 'missing_methods' : 'available', missingMethods: missingContextMethods }
      : { status: 'no_active_context', missingMethods: [] },
  };
}
