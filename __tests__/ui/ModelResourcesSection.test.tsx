import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ModelResourcesSection } from '../../src/components/model-details/ModelResourcesSection';
import { checkAuxiliaryModel, selectAuxiliaryModel } from '../../src/services/AuxiliaryModelService';
import { getModelDownloadManager } from '../../src/services/ModelDownloadManager';
import { ttsService } from '../../src/services/TtsService';
import type { AppSettings, AuxiliaryModelRole } from '../../src/services/SettingsStore';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';
import { TtsError } from '../../src/types/tts';
import { bindManagedCompanion } from '../../src/utils/modelArtifacts';
import { getModelFileIdentity } from '../../src/utils/modelRoles';

jest.mock('../../src/providers/ThemeProvider', () => {
  const { resolveTheme } = jest.requireActual('../../src/design-system/themes/resolver');
  return { useTheme: () => {
    const resolvedTheme = resolveTheme('default', 'light');
    return { resolvedTheme, colors: resolvedTheme.colors };
  } };
});
jest.mock('../../src/components/ui/MaterialSymbols', () => ({ MaterialSymbols: () => null }));
jest.mock('../../src/components/model-details/ModelLoraControls', () => ({ ModelLoraControls: () => null }));

let mockSettings: Pick<AppSettings, 'auxiliaryModels' | 'showAdvancedInferenceControls' | 'autoSelectTtsModel'>;
let mockQueue: ModelMetadata[];
let mockResolvedModels: Partial<Record<AuxiliaryModelRole, ModelMetadata>>;
const mockSettingsListeners = new Set<(settings: typeof mockSettings) => void>();
const mockModelsListeners = new Set<() => void>();
jest.mock('../../src/services/SettingsStore', () => ({
  getSettings: () => ({ ...mockSettings }), subscribeSettings: (listener: (settings: typeof mockSettings) => void) => {
    mockSettingsListeners.add(listener); return () => mockSettingsListeners.delete(listener);
  },
}));
jest.mock('../../src/store/downloadStore', () => ({
  useDownloadStore: (selector: (state: { queue: ModelMetadata[] }) => unknown) => selector({ queue: mockQueue }),
}));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: {
  updateModel: jest.fn(), subscribeModels: (listener: () => void) => {
    mockModelsListeners.add(listener); return () => mockModelsListeners.delete(listener);
  },
} }));
jest.mock('../../src/services/ModelDownloadManager', () => ({ getModelDownloadManager: jest.fn() }));
jest.mock('../../src/services/AuxiliaryModelService', () => ({
  AuxiliaryModelError: class extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  checkAuxiliaryModel: jest.fn(), selectAuxiliaryModel: jest.fn(),
  getAuxiliarySelection: (role: AuxiliaryModelRole) => mockResolvedModels[role],
  resolveModelForResourceEdit: (model: ModelMetadata) => model,
}));
jest.mock('../../src/services/TtsService', () => ({ ttsService: {
  checkFiles: jest.fn(), cancelAndClear: jest.fn(), start: jest.fn(),
} }));

function preparedModel(role: AuxiliaryModelRole): ModelMetadata {
  const model: ModelMetadata = {
    id: `model-${role}`, name: 'Resource model', author: 'test', size: 1000,
    downloadUrl: `https://example.test/${role}.gguf`, resolvedFileName: `${role}.gguf`,
    sha256: 'a'.repeat(64), fitsInRam: null, accessState: ModelAccessState.PUBLIC,
    isGated: false, isPrivate: false, lifecycleStatus: LifecycleStatus.DOWNLOADED,
    downloadProgress: 1, localPath: `${role}.gguf`,
    roleEvidence: [{ role, source: 'pipeline_tag', confidence: 'declared' }],
  };
  if (role !== 'tts') return model;
  const bound = bindManagedCompanion(model, { kind: 'tts_codec',
    downloadUrl: 'https://example.test/codec.gguf', sizeBytes: 100, sha256: 'b'.repeat(64) });
  return { ...bound, artifacts: bound.artifacts!.map(artifact => ({ ...artifact,
    installState: 'installed' as const, localPath: 'codec.gguf' })) };
}

function select(model: ModelMetadata, role: AuxiliaryModelRole): void {
  mockResolvedModels[role] = model;
  mockSettings = { auxiliaryModels: {
    [role]: { modelId: model.id, fileIdentity: getModelFileIdentity(model) },
  } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettings = { auxiliaryModels: {} };
  mockQueue = [];
  mockResolvedModels = {};
  mockSettingsListeners.clear();
  mockModelsListeners.clear();
  jest.mocked(ttsService.checkFiles).mockReset().mockResolvedValue(undefined);
  jest.mocked(ttsService.cancelAndClear).mockReset().mockResolvedValue(undefined);
  jest.mocked(checkAuxiliaryModel).mockReset().mockResolvedValue({ operation: 'load', memoryConfidence: 'low' });
});

it('checks TTS files without offering generic load checks or claiming verified speech', async () => {
  const model = preparedModel('tts');
  select(model, 'tts');
  const view = render(<ModelResourcesSection model={model} />);
  expect(view.queryByTestId('resource-check-tts')).toBeNull();
  expect(view.queryByText('resources.checkLoad')).toBeNull();
  expect(view.getByTestId('resource-check-tts-files')).toBeEnabled();
  fireEvent.press(view.getByTestId('resource-check-tts-files'));
  await waitFor(() => expect(view.getByText('tts.filesChecked')).toBeTruthy());
  expect(ttsService.checkFiles).toHaveBeenCalledTimes(1);
  expect(checkAuxiliaryModel).not.toHaveBeenCalled();
  expect(ttsService.start).not.toHaveBeenCalled();
  expect(getModelDownloadManager).not.toHaveBeenCalled();
  expect(view.getByText(/resources.loadUnverified/)).toBeTruthy();
  expect(view.queryByText(/resources.loadVerified/)).toBeNull();
});

it.each(['unselected', 'missing codec', 'queued'] as const)('blocks TTS file checking when %s', reason => {
  const prepared = preparedModel('tts');
  const model = reason === 'missing codec' ? { ...prepared, artifacts: [] } : prepared;
  if (reason !== 'unselected') select(model, 'tts');
  if (reason === 'queued') mockQueue = [{ ...model, lifecycleStatus: LifecycleStatus.QUEUED }];
  const view = render(<ModelResourcesSection model={model} />);
  const button = view.getByTestId('resource-check-tts-files');
  expect(button).toBeDisabled();
  fireEvent.press(button);
  expect(ttsService.checkFiles).not.toHaveBeenCalled();
  expect(checkAuxiliaryModel).not.toHaveBeenCalled();
});

it('reports failed TTS file integrity without routing to a generic load check', async () => {
  const model = preparedModel('tts');
  select(model, 'tts');
  jest.mocked(ttsService.checkFiles).mockRejectedValueOnce(new TtsError('integrity_failed'));
  const view = render(<ModelResourcesSection model={model} />);
  fireEvent.press(view.getByTestId('resource-check-tts-files'));
  await waitFor(() => expect(view.getByText('tts.errors.integrity_failed')).toBeTruthy());
  expect(view.queryByText('tts.filesChecked')).toBeNull();
  expect(checkAuxiliaryModel).not.toHaveBeenCalled();
});

it.each(['embedding', 'reranker'] as const)('retains the native load check for %s', async role => {
  const model = preparedModel(role);
  select(model, role);
  const view = render(<ModelResourcesSection model={model} />);
  expect(view.queryByTestId('resource-check-tts-files')).toBeNull();
  expect(view.getByTestId(`resource-check-${role}`)).toBeEnabled();
  fireEvent.press(view.getByTestId(`resource-check-${role}`));
  await waitFor(() => expect(view.getByText('resources.checkPassed')).toBeTruthy());
  expect(checkAuxiliaryModel).toHaveBeenCalledWith(role, { signal: expect.any(AbortSignal) });
  expect(ttsService.checkFiles).not.toHaveBeenCalled();
});

it('shows the resolved automatic TTS model as selected and allows explicit unselect', async () => {
  const model = preparedModel('tts');
  mockSettings = { auxiliaryModels: {}, autoSelectTtsModel: true };
  mockResolvedModels.tts = model;
  const view = render(<ModelResourcesSection model={model} />);
  expect(view.getByText('resources.unselect')).toBeTruthy();
  expect(view.getByTestId('resource-check-tts-files')).toBeEnabled();
  fireEvent.press(view.getByText('resources.unselect'));
  await waitFor(() => expect(selectAuxiliaryModel).toHaveBeenCalledWith('tts', null));
  act(() => {
    mockSettings = { auxiliaryModels: {}, autoSelectTtsModel: false };
    delete mockResolvedModels.tts;
    mockSettingsListeners.forEach(listener => listener(mockSettings));
  });
  expect(view.queryByText('resources.unselect')).toBeNull();
  expect(view.getByTestId('resource-check-tts-files')).toBeDisabled();
});

it('refreshes automatic selection on registry changes and unsubscribes on unmount', () => {
  const model = preparedModel('tts');
  const view = render(<ModelResourcesSection model={model} />);
  expect(view.queryByText('resources.unselect')).toBeNull();
  act(() => {
    mockResolvedModels.tts = model;
    mockModelsListeners.forEach(listener => listener());
  });
  expect(view.getByText('resources.unselect')).toBeTruthy();
  act(() => {
    delete mockResolvedModels.tts;
    mockModelsListeners.forEach(listener => listener());
  });
  expect(view.queryByText('resources.unselect')).toBeNull();
  expect(mockModelsListeners.size).toBe(1);
  view.unmount();
  expect(mockModelsListeners.size).toBe(0);
  expect(mockSettingsListeners.size).toBe(0);
});
