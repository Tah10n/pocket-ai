import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ModelLoraControls } from '../../src/components/model-details/ModelLoraControls';
import { applyModelLoraAdapters } from '../../src/services/LoraConfigurationService';
import { EngineStatus, LifecycleStatus, ModelAccessState, type EngineState, type ModelMetadata } from '../../src/types/models';
import type { ModelLoadParameters } from '../../src/services/SettingsStore';
import type { LoraProfileAdapter } from '../../src/utils/advancedLoadProfile';

let mockEngineState: EngineState;
let mockProfile: ModelLoadParameters | null;
let mockGenerationBusy = false;
let mockListener: ((state: EngineState) => void) | undefined;
jest.mock('../../src/providers/ThemeProvider', () => {
  const { resolveTheme } = jest.requireActual('../../src/design-system/themes/resolver');
  return { useTheme: () => { const resolvedTheme = resolveTheme('default', 'light'); return { resolvedTheme, colors: resolvedTheme.colors }; } };
});
jest.mock('../../src/components/ui/MaterialSymbols', () => ({ MaterialSymbols: () => null }));
jest.mock('../../src/services/LoraConfigurationService', () => ({ applyModelLoraAdapters: jest.fn() }));
jest.mock('../../src/services/SettingsStore', () => ({ getModelLoadParametersForModel: () => ({ loraAdapters: [] }) }));
jest.mock('../../src/services/ChatGenerationService', () => ({ hasActiveChatGenerationWork: () => mockGenerationBusy }));
jest.mock('../../src/store/chatStore', () => ({ useChatStore: (selector: (state: { activeThreadId: string }) => unknown) => selector({ activeThreadId: 'chat-a' }) }));
jest.mock('../../src/utils/modelArtifacts', () => ({
  getCompanionBindingIdentity: () => 'base', getManagedCompanionArtifacts: (model: ModelMetadata) => model.artifacts ?? [],
}));
jest.mock('../../src/services/LLMEngineService', () => ({ llmEngineService: {
  getState: () => mockEngineState, getEffectiveLoadParameters: () => mockProfile,
  hasActiveCompletion: () => mockGenerationBusy, hasActiveContextOperation: () => false,
  subscribe: (listener: (state: EngineState) => void) => { mockListener = listener; listener(mockEngineState); return () => { mockListener = undefined; }; },
} }));
const applyMock = jest.mocked(applyModelLoraAdapters);
const profileAdapter = (artifactId: string, scale = 1): LoraProfileAdapter => ({ artifactId, scale, artifactIdentity: artifactId, baseModelIdentity: 'base', sizeBytes: 100 });
const model: ModelMetadata = {
  id: 'model-a', name: 'Model A', author: 'test', size: 1000, downloadUrl: 'https://example.test/base.gguf',
  fitsInRam: true, accessState: ModelAccessState.PUBLIC, isGated: false, isPrivate: false,
  lifecycleStatus: LifecycleStatus.DOWNLOADED, downloadProgress: 100, localPath: 'base.gguf',
  artifacts: ['first', 'second'].map(id => ({ id, kind: 'lora_adapter', requiredFor: [], selected: false,
    boundToModelIdentity: 'base', remoteFileName: `${id}.gguf`, downloadUrl: `https://example.test/${id}.gguf`,
    sizeBytes: 100, localPath: `${id}.gguf`, installState: 'installed' })),
};
const defaultProfile = (): ModelLoadParameters => ({ contextSize: 512, gpuLayers: 0, kvCacheType: 'f16', loraAdapters: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('ModelLoraControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerationBusy = false;
    mockEngineState = { status: EngineStatus.READY, activeModelId: model.id, loadProgress: 1 };
    mockProfile = defaultProfile();
  });
  it('selects multiple prepared adapters and applies zero scale only on explicit action', async () => {
    const onBusy = jest.fn();
    const pending = deferred<LoraProfileAdapter[]>();
    applyMock.mockReturnValueOnce(pending.promise);
    const view = render(<ModelLoraControls model={model} onBusyChange={onBusy} />);
    fireEvent.press(view.getByTestId('lora-select-first'));
    fireEvent.changeText(view.getByTestId('lora-scale-first'), '0');
    fireEvent.press(view.getByTestId('lora-select-second'));
    expect(applyMock).not.toHaveBeenCalled();
    expect(view.getByTestId('lora-native-empty')).toBeTruthy();
    fireEvent.press(view.getByTestId('lora-apply'));
    expect(applyMock).toHaveBeenCalledWith('model-a', [{ artifactId: 'first', scale: 0 }, { artifactId: 'second', scale: 1 }], expect.any(AbortSignal));
    expect(view.queryByTestId('lora-native-empty')).toBeNull();
    expect(view.getByTestId('lora-native-unconfirmed')).toBeTruthy();
    const applied = [profileAdapter('first', 0), profileAdapter('second')];
    await act(async () => { mockProfile = { ...defaultProfile(), loraAdapters: applied }; pending.resolve(applied); });
    expect(view.getByTestId('lora-applied-first')).toBeTruthy();
    expect(view.getByTestId('lora-applied-second')).toBeTruthy();
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
  });
  it('does not change the confirmed list while editing selection or invalid scale', () => {
    mockProfile = { ...defaultProfile(), loraAdapters: [profileAdapter('first')] };
    const view = render(<ModelLoraControls model={model} onBusyChange={jest.fn()} />);
    fireEvent.press(view.getByTestId('lora-select-second'));
    fireEvent.changeText(view.getByTestId('lora-scale-second'), '');
    fireEvent.press(view.getByTestId('lora-apply'));
    expect(applyMock).not.toHaveBeenCalled();
    expect(view.getByRole('alert')).toBeTruthy();
    expect(view.getByTestId('lora-applied-first')).toBeTruthy();
    expect(view.queryByTestId('lora-applied-second')).toBeNull();
  });
  it('removes all through the same confirmed production operation', async () => {
    mockProfile = { ...defaultProfile(), loraAdapters: [profileAdapter('first')] };
    applyMock.mockImplementationOnce(async () => { mockProfile = defaultProfile(); return []; });
    const view = render(<ModelLoraControls model={model} onBusyChange={jest.fn()} />);
    fireEvent.press(view.getByTestId('lora-remove-all'));
    await waitFor(() => expect(view.getByTestId('lora-native-empty')).toBeTruthy());
    expect(applyMock).toHaveBeenCalledWith('model-a', [], expect.any(AbortSignal));
  });
  it('keeps the operation busy after cancel until the native-backed promise settles', async () => {
    const pending = deferred<LoraProfileAdapter[]>();
    applyMock.mockReturnValueOnce(pending.promise);
    const view = render(<ModelLoraControls model={model} onBusyChange={jest.fn()} />);
    fireEvent.press(view.getByTestId('lora-select-first'));
    fireEvent.press(view.getByTestId('lora-apply'));
    fireEvent.press(view.getByTestId('lora-cancel'));
    expect(applyMock.mock.calls[0][2]?.aborted).toBe(true);
    fireEvent.press(view.getByTestId('lora-apply'));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('lora-native-unconfirmed')).toBeTruthy();
    await act(async () => { pending.reject(new Error('private/path/native error')); });
    expect(view.queryByText('private/path/native error')).toBeNull();
    expect(view.getByText('loraControls.failed')).toBeTruthy();
  });
  it('blocks generation overlap and suppresses uncertain recovery state', () => {
    mockGenerationBusy = true;
    const view = render(<ModelLoraControls model={model} onBusyChange={jest.fn()} />);
    fireEvent.press(view.getByTestId('lora-select-first'));
    fireEvent.press(view.getByTestId('lora-apply'));
    expect(applyMock).not.toHaveBeenCalled();
    act(() => { mockEngineState = { ...mockEngineState, diagnostics: { backendMode: 'cpu', backendDevices: [], contextRecoveryStatus: 'required' } }; mockListener?.(mockEngineState); });
    expect(view.getByTestId('lora-native-unconfirmed')).toBeTruthy();
    expect(view.queryByTestId('lora-native-empty')).toBeNull();
  });
  it('does not admit unprepared or wrong-base companions', () => {
    const badModel = { ...model, artifacts: model.artifacts?.map(artifact => ({ ...artifact, boundToModelIdentity: 'other-base' })) };
    const view = render(<ModelLoraControls model={badModel} onBusyChange={jest.fn()} />);
    fireEvent.press(view.getByTestId('lora-select-first'));
    expect(view.queryByTestId('lora-scale-first')).toBeNull();
  });
});
