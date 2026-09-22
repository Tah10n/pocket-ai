import type { ChatThread } from '../types/chat';
import type { ModelLoadParameters } from '../services/SettingsStore';
import { sanitizeLoraProfileAdapters } from './advancedLoadProfile';

/** Ordered, path-free execution identity. Missing legacy snapshots mean the base model. */
export function loraExecutionIdentity(adapters: unknown): string {
  return JSON.stringify((sanitizeLoraProfileAdapters(adapters) ?? []).map(adapter => [
    adapter.artifactId, adapter.artifactIdentity, adapter.baseModelIdentity, adapter.scale,
  ]));
}

export function isThreadLoraProfileReady(thread: Pick<ChatThread, 'loraSnapshot'>, profile: ModelLoadParameters | null | undefined): boolean {
  return loraExecutionIdentity(thread.loraSnapshot) === loraExecutionIdentity(profile?.loraAdapters);
}
