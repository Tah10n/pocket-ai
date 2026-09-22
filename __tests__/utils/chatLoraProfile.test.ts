import { isThreadLoraProfileReady, loraExecutionIdentity } from '../../src/utils/chatLoraProfile';
import type { LoraProfileAdapter } from '../../src/utils/advancedLoadProfile';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';

const adapter = (id: string, scale: number): LoraProfileAdapter => ({ artifactId: id,
  artifactIdentity: `${id}:revision`, baseModelIdentity: 'base:revision', scale, sizeBytes: 64 });
const profile = (loraAdapters?: LoraProfileAdapter[]): ModelLoadParameters => ({ contextSize: 4096, gpuLayers: 0, kvCacheType: 'f16', loraAdapters });

it('treats a legacy chat as a base-only request even when the global model has adapters', () => {
  expect(isThreadLoraProfileReady({}, profile())).toBe(true);
  expect(isThreadLoraProfileReady({}, profile([]))).toBe(true);
  expect(isThreadLoraProfileReady({}, profile([adapter('a', 1)]))).toBe(false);
});

it('requires the same ordered identities and scales including explicit zero after auxiliary restore', () => {
  const original = [adapter('a', 0), adapter('b', 0.5)];
  expect(isThreadLoraProfileReady({ loraSnapshot: original }, profile(original.map(value => ({ ...value }))))).toBe(true);
  expect(isThreadLoraProfileReady({ loraSnapshot: original }, profile([...original].reverse()))).toBe(false);
  expect(isThreadLoraProfileReady({ loraSnapshot: original }, profile([adapter('a', 1), original[1]]))).toBe(false);
  expect(loraExecutionIdentity(original)).not.toBe(loraExecutionIdentity([{ ...original[0], artifactIdentity: 'new-revision' }, original[1]]));
});
