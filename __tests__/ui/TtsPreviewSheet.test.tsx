import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { TtsPreviewSheet } from '../../src/components/ui/TtsPreviewSheet';
import { ttsService, getTtsSelectionStatus } from '../../src/services/TtsService';
import * as DocumentPicker from 'expo-document-picker';
import { referenceVoiceStore, type TemporaryReferenceSource } from '../../src/services/ReferenceVoiceStore';
import { prepareManagedAudio, discardPreparedAudio, waitForAudioPreparationDrain, type PreparedAudio } from '../../src/services/AudioPreparationService';
import { audioSamplePreviewService } from '../../src/services/AudioSamplePreviewService';
import type { AudioRecordingSheet } from '../../src/components/ui/AudioRecordingSheet';
import en from '../../src/i18n/locales/en.json';
import ru from '../../src/i18n/locales/ru.json';
import type { TtsModelSetupState } from '../../src/services/TtsModelSetupService';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return { createInteropElement: mockReact.createElement };
});
jest.mock('../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react'), { View } = require('react-native');
  const Container = ({ children, ...props }: any) => mockReact.createElement(View, props, children);
  const { Pressable, Text } = require('react-native');
  const Action = ({ children, iconName, ...props }: any) => mockReact.createElement(Pressable, props, children);
  const Segmented = ({ options, activeKey, onChange, disabled, ...props }: any) => mockReact.createElement(View, props,
    options.map((option: any) => mockReact.createElement(Pressable, { key: option.key, testID: option.testID,
      disabled, accessibilityState: { selected: activeKey === option.key, disabled }, onPress: () => onChange(option.key) },
    mockReact.createElement(Text, {}, option.label))));
  return { ScreenModalOverlay: Container, ScreenSheet: Container, ScreenCard: Container,
    ScreenPressableCard: Action, ScreenIconButton: Action, ScreenSegmentedControl: Segmented };
});
jest.mock('../../src/components/ui/MaterialSymbols', () => ({ MaterialSymbols: () => null }));
const mockSettingsListeners = new Set<() => void>();
jest.mock('../../src/services/SettingsStore', () => ({ subscribeSettings: (listener: () => void) => {
  mockSettingsListeners.add(listener); return () => mockSettingsListeners.delete(listener);
} }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { subscribeModels: () => () => undefined } }));
let mockSetupState: TtsModelSetupState = { phase: 'idle', progress: 0 };
let mockRecommendedInstalled = false;
const mockSetupListeners = new Set<() => void>();
const mockStartRecommended = jest.fn();
const mockCancelModelSetup = jest.fn();
jest.mock('../../src/services/TtsModelSetupService', () => ({
  RECOMMENDED_TTS_DOWNLOAD_MIB: 524,
  getInstalledRecommendedTtsModel: () => mockRecommendedInstalled ? { id: 'installed-oute' } : undefined,
  TtsModelSetupService: class {
    getState = () => mockSetupState;
    subscribe = (listener: () => void) => { mockSetupListeners.add(listener); return () => mockSetupListeners.delete(listener); };
    startRecommended = (...args: unknown[]) => mockStartRecommended(...args);
    cancel = () => mockCancelModelSetup();
  },
}));

let mockSavedState = { voices: [] as any[], selectedVoiceId: null as string | null };
const mockSavedListeners = new Set<() => void>();
jest.mock('../../src/services/ReferenceVoiceStore', () => ({ referenceVoiceStore: {
  getState: () => mockSavedState,
  subscribe: (listener: () => void) => { mockSavedListeners.add(listener); return () => mockSavedListeners.delete(listener); },
  hydrate: jest.fn(), retainTemporarySource: jest.fn(), save: jest.fn(), delete: jest.fn(), select: jest.fn(),
} }));
jest.mock('../../src/services/AudioPreparationService', () => ({
  prepareManagedAudio: jest.fn(), discardPreparedAudio: jest.fn(), waitForAudioPreparationDrain: jest.fn(),
}));
let mockSampleState = { phase: 'idle' };
const mockSampleListeners = new Set<() => void>();
jest.mock('../../src/services/AudioSamplePreviewService', () => ({ audioSamplePreviewService: {
  getState: () => mockSampleState,
  subscribe: (listener: () => void) => { mockSampleListeners.add(listener); return () => mockSampleListeners.delete(listener); },
  play: jest.fn(), stop: jest.fn(),
} }));
let mockRecordingProps: React.ComponentProps<typeof AudioRecordingSheet> | undefined;
jest.mock('../../src/components/ui/AudioRecordingSheet', () => {
  const mockReact = require('react'), { View } = require('react-native');
  return { AudioRecordingSheet: (props: any) => { mockRecordingProps = props;
    return mockReact.createElement(View, { testID: 'reference-recording-sheet' }); } };
});

let mockSelection: ReturnType<typeof getTtsSelectionStatus> = { profileId: 'outetts-1.0', modelName: 'Oute', languages: ['en'], requiredBytes: 1 };
let mockState: Record<string, unknown> = { phase: null };
const mockListeners = new Set<() => void>();
jest.mock('../../src/services/TtsService', () => ({
  getTtsSelectionStatus: () => mockSelection,
  ttsService: {
    getState: () => mockState,
    subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
    start: jest.fn(), checkFiles: jest.fn(), cancelAndClear: jest.fn(),
    play: jest.fn(), pause: jest.fn(), replay: jest.fn(), stop: jest.fn(),
  },
}));
const service = ttsService as jest.Mocked<typeof ttsService>;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function props(overrides: Partial<React.ComponentProps<typeof TtsPreviewSheet>> = {}) {
  return { initialText: 'The blue door is open.', isPreviewCurrent: () => true,
    onClose: jest.fn(), onOpenModels: jest.fn(), onCleanupFailure: jest.fn(), ...overrides };
}
function renderSheet(options: React.ComponentProps<typeof TtsPreviewSheet>) {
  const view = render(<TtsPreviewSheet {...options} />);
  fireEvent.press(view.getByTestId('tts-voice-options'));
  return view;
}
beforeEach(() => {
  mockSelection = { profileId: 'outetts-1.0', modelName: 'Oute', languages: ['en'], requiredBytes: 1 };
  mockState = { phase: null };
  mockListeners.clear();
  mockSettingsListeners.clear();
  mockSetupState = { phase: 'idle', progress: 0 };
  mockRecommendedInstalled = false;
  mockSetupListeners.clear();
  mockSavedState = { voices: [], selectedVoiceId: null };
  mockSavedListeners.clear();
  mockSampleState = { phase: 'idle' };
  mockSampleListeners.clear();
  mockRecordingProps = undefined;
  jest.clearAllMocks();
  mockStartRecommended.mockReset().mockResolvedValue(undefined);
  mockCancelModelSetup.mockReset().mockResolvedValue(undefined);
  for (const method of ['start', 'checkFiles', 'cancelAndClear', 'play', 'pause', 'replay', 'stop'] as const) {
    service[method].mockResolvedValue(undefined);
  }
  jest.mocked(discardPreparedAudio).mockReset().mockResolvedValue(undefined);
  jest.mocked(waitForAudioPreparationDrain).mockReset().mockResolvedValue(undefined);
  jest.mocked(prepareManagedAudio).mockReset().mockResolvedValue(preparedReference);
  jest.mocked(audioSamplePreviewService.stop).mockReset().mockResolvedValue(undefined);
  jest.mocked(audioSamplePreviewService.play).mockReset().mockResolvedValue(undefined);
  jest.mocked(referenceVoiceStore.retainTemporarySource).mockReset().mockResolvedValue(temporaryReference());
  jest.mocked(referenceVoiceStore.save).mockReset();
  jest.mocked(referenceVoiceStore.select).mockReset();
  jest.mocked(referenceVoiceStore.delete).mockReset().mockResolvedValue(undefined);
  jest.mocked(DocumentPicker.getDocumentAsync).mockReset().mockResolvedValue({ canceled: true, assets: null });
});

const preparedReference: PreparedAudio = { uri: 'file:///test-cache/audio-preparation/preview.wav',
  sourceSha256: 'a'.repeat(64), identity: 'private-reference-profile', sampleRate: 24000,
  sampleCount: 24000, durationMs: 1000, channels: 1, sizeBytes: 48044 };
function temporaryReference(): TemporaryReferenceSource {
  return { uri: 'file:///test-cache/audio-reference/immutable.wav', sourceSha256: 'a'.repeat(64),
    durationMs: 1000, sourceMimeType: 'audio/wav', isCurrent: jest.fn(() => true), release: jest.fn(async () => undefined) };
}
async function useRecordedReference(view: ReturnType<typeof render>) {
  fireEvent.press(view.getByTestId('tts-reference-record'));
  await waitFor(() => expect(view.getByTestId('reference-recording-sheet')).toBeTruthy());
  await act(async () => { await mockRecordingProps!.onAttach(preparedReference, {
    uri: 'file:///test-cache/recorder/source.m4a', container: 'm4a', byteSize: 4096, durationMillis: 1000,
    recorderId: 'recording-owner', requestId: 1,
  }, { assertCurrent: () => undefined }); mockRecordingProps!.onClose(); });
  await waitFor(() => expect(view.getByTestId('tts-reference-preview')).toBeTruthy());
}

it('keeps file checking separate from speech and submits only the exact visible preview', async () => {
  const source = { threadId: 'thread', messageId: 'answer' };
  const view = renderSheet(props({ source }));
  expect(service.start).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('tts-advanced-toggle'));
  fireEvent.press(view.getByTestId('tts-check-files'));
  await waitFor(() => expect(view.getByTestId('tts-files-checked')).toBeTruthy());
  expect(service.start).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  expect(service.start.mock.calls[0][0]).toMatchObject({
    text: 'The blue door is open.', language: 'en', source, playAfterSynthesis: true,
  });
  expect(service.start.mock.calls[0][0].isTextCurrent?.()).toBe(true);
  expect(service.start.mock.calls[0][0].isRestoreCurrent?.()).toBe(true);
});

it('preserves pasted over-limit input and disables synthesis without silent truncation', async () => {
  const view = renderSheet(props());
  const input = view.getByTestId('tts-text-input');
  expect(input.props.maxLength).toBeUndefined();
  const pasted = 'x'.repeat(241);
  fireEvent.changeText(input, pasted);
  await act(async () => undefined);
  expect(view.getByTestId('tts-text-input').props.value).toBe(pasted);
  expect(view.getByTestId('tts-exact-preview').props.children).toBe(pasted);
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(service.start).not.toHaveBeenCalled();
});

it('invalidates an in-flight request on edits and blocks new starts until cleanup settles', async () => {
  const synthesis = deferred(), cleanup = deferred();
  service.start.mockReturnValueOnce(synthesis.promise);
  const view = renderSheet(props());
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  const request = service.start.mock.calls[0][0];
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  fireEvent.changeText(view.getByTestId('tts-text-input'), 'A different sentence.');
  expect(request.isTextCurrent?.()).toBe(false);
  expect(request.isRestoreCurrent?.()).toBe(false);
  expect(service.cancelAndClear).toHaveBeenCalled();
  await act(async () => { synthesis.resolve(); await synthesis.promise; });
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  await act(async () => { cleanup.resolve(); await cleanup.promise; });
  expect(view.getByTestId('tts-synthesize')).toBeEnabled();
});

it('preserves structured input and requires explicit review', async () => {
  const text = '{\n  "value": 42\n}';
  const view = renderSheet(props({ initialText: text, reviewReason: 'structured' }));
  expect(view.getByTestId('tts-exact-preview').props.children).toBe(text);
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  fireEvent.press(view.getByTestId('tts-confirm-review'));
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  expect(service.start.mock.calls[0][0].text).toBe(text);
});

it('rejects protocol and private paths without exposing them as a speech request', () => {
  const view = renderSheet(props({ initialText: 'file:///data/user/0/private.wav' }));
  expect(view.getByTestId('tts-error').props.children).toBe('tts.errors.unsafe_content');
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(service.start).not.toHaveBeenCalled();
});

it('replays a ready clip without invoking synthesis', async () => {
  mockState = { phase: 'ready', sampleCount: 24000, duration: 1, position: 0 };
  const view = renderSheet(props());
  fireEvent.press(view.getByTestId('tts-replay'));
  await waitFor(() => expect(service.replay).toHaveBeenCalledTimes(1));
  expect(service.start).not.toHaveBeenCalled();
});

it('closes only after clearing and draining the player/native owner', async () => {
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  const onClose = jest.fn();
  const view = renderSheet(props({ onClose }));
  fireEvent.press(view.getByTestId('tts-close'));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { cleanup.resolve(); await cleanup.promise; });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps stable restoration current after close/unmount while deferred cleanup blocks late playback', async () => {
  const synthesis = deferred(), cleanup = deferred();
  service.start.mockReturnValueOnce(synthesis.promise);
  let visible = true;
  const view = renderSheet(props({ isPreviewCurrent: () => visible }));
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  const request = service.start.mock.calls[0][0];
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  fireEvent.press(view.getByTestId('tts-close'));
  visible = false;
  expect(request.isTextCurrent?.()).toBe(false);
  expect(request.isRestoreCurrent?.()).toBe(true);
  view.unmount();
  expect(request.isTextCurrent?.()).toBe(false);
  expect(request.isRestoreCurrent?.()).toBe(true);
  // Selection changes still invalidate restoration after the sheet unsubscribes.
  mockSelection = { ...mockSelection, profileId: 'changed' };
  expect(request.isRestoreCurrent?.()).toBe(false);
  await act(async () => { synthesis.resolve(); cleanup.resolve(); await Promise.all([synthesis.promise, cleanup.promise]); });
});

it.each(['language', 'selection'] as const)('invalidates stable restoration on a %s change before deferred drain', async change => {
  mockSelection = { ...mockSelection, languages: ['en', 'zh-tw'] };
  const synthesis = deferred(), cleanup = deferred();
  service.start.mockReturnValueOnce(synthesis.promise);
  const view = renderSheet(props());
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  const request = service.start.mock.calls[0][0];
  expect(request.isRestoreCurrent?.()).toBe(true);
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  if (change === 'language') fireEvent.press(view.getByTestId('tts-language-zh-tw'));
  else await act(async () => {
    mockSelection = { ...mockSelection, profileId: 'changed' };
    mockSettingsListeners.forEach(listener => listener());
  });
  expect(request.isTextCurrent?.()).toBe(false);
  expect(request.isRestoreCurrent?.()).toBe(false);
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  await act(async () => { synthesis.resolve(); cleanup.resolve(); await Promise.all([synthesis.promise, cleanup.promise]); });
  expect(request.isRestoreCurrent?.()).toBe(false);
});

it('records cleanup failure and keeps synthesis blocked', async () => {
  const onCleanupFailure = jest.fn();
  const view = renderSheet(props({ onCleanupFailure }));
  service.cancelAndClear.mockRejectedValueOnce(new Error('private native details'));
  fireEvent.changeText(view.getByTestId('tts-text-input'), 'Changed.');
  await waitFor(() => expect(onCleanupFailure).toHaveBeenCalled());
  expect(view.getByTestId('tts-error').props.children).toBe('tts.errors.storage_failed');
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(view.queryByText('private native details')).toBeNull();
});

it('defines every speech phase and sanitized error in both UI languages', () => {
  expect(Object.keys(en.tts.phases).sort()).toEqual(Object.keys(ru.tts.phases).sort());
  expect(Object.keys(en.tts.errors).sort()).toEqual(Object.keys(ru.tts.errors).sort());
  expect(en.tts.errors.storage_failed).toBeTruthy();
  expect(ru.tts.errors.memory_unknown).toBeTruthy();
});


it.each(['audio_focus_failed', 'audio_focus_delayed', 'playback_start_timeout'])('shows %s with explicit Play retry on the retained WAV', async errorCode => {
  mockState = { phase: 'error', errorCode, sampleCount: 24000, duration: 1, position: 0, clipAvailable: true };
  const view = renderSheet(props());
  expect(view.getByTestId('tts-error').props.children).toBe('tts.errors.' + errorCode);
  expect(view.getByTestId('tts-phase').props.children).toBe('tts.phases.error');
  expect(view.getByTestId('tts-play')).toBeEnabled();
  fireEvent.press(view.getByTestId('tts-play'));
  await waitFor(() => expect(service.play).toHaveBeenCalledTimes(1));
  expect(service.start).not.toHaveBeenCalled();
});

it('keeps pending native startup separate from Playing and Stop available', () => {
  mockState = { phase: 'starting', sampleCount: 24000, clipAvailable: true };
  const view = renderSheet(props());
  expect(view.getByTestId('tts-phase').props.children).toBe('tts.phases.starting');
  expect(view.queryByTestId('tts-pause')).toBeNull();
  expect(view.getByTestId('tts-stop')).toBeTruthy();
});

it('submits the selected builtin with speech language admission and shows only that profile voice list', async () => {
  mockSelection = { profileId: 'neutts-nano', modelName: 'NeuTTS', languages: ['en'], voiceModes: ['builtin'],
    builtinVoices: ['default', 'dave', 'jo'] };
  const view = renderSheet(props());
  expect(view.queryByTestId('tts-mode-reference')).toBeNull();
  expect(view.queryByTestId('tts-language-de')).toBeNull();
  fireEvent.press(view.getByTestId('tts-builtin-jo'));
  await waitFor(() => expect(view.getByTestId('tts-synthesize')).toBeEnabled());
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({
    language: 'en', voice: { kind: 'builtin', voice: 'jo' },
  })));
});

it('invalidates voice synthesis while preserving unchanged chat restoration when voice mode changes', async () => {
  mockSelection = { profileId: 'qwen3-tts', modelName: 'Qwen', languages: ['en'], voiceModes: ['speakerless', 'reference'] };
  const synthesis = deferred(), cleanup = deferred(); service.start.mockReturnValueOnce(synthesis.promise);
  const view = renderSheet(props());
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  const request = service.start.mock.calls[0][0];
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  fireEvent.press(view.getByTestId('tts-mode-reference'));
  expect(request.isTextCurrent?.()).toBe(false); expect(request.isRestoreCurrent?.()).toBe(true);
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  await act(async () => { synthesis.resolve(); cleanup.resolve(); await Promise.all([synthesis.promise, cleanup.promise]); });
  expect(view.getByTestId('tts-synthesize')).toBeDisabled(); // No sample/permission means no reference request.
});

it('offers real eager/lazy preparation but no transcript or emotion controls for Qwen', () => {
  mockSelection = { profileId: 'qwen3-tts', modelName: 'Qwen', languages: ['en'], voiceModes: ['reference'] };
  const view = renderSheet(props());
  fireEvent.press(view.getByTestId('tts-advanced-toggle'));
  expect(view.getByTestId('tts-bake-eager')).toBeTruthy(); expect(view.getByTestId('tts-bake-lazy')).toBeTruthy();
  expect(view.getByTestId('tts-reference-record')).toBeTruthy(); expect(view.getByTestId('tts-reference-import')).toBeTruthy();
  expect(view.queryByTestId('tts-ref-text')).toBeNull(); expect(view.queryByTestId('tts-emotion')).toBeNull();
  expect(service.start).not.toHaveBeenCalled(); expect(view.getByTestId('tts-synthesize')).toBeDisabled();
});

it('opens reference recording only after an explicit action and audio drain, with a temporary consent-gated sample', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  const view = renderSheet(props());
  expect(mockRecordingProps).toBeUndefined();
  expect(prepareManagedAudio).not.toHaveBeenCalled();
  expect(referenceVoiceStore.retainTemporarySource).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('tts-reference-record'));
  expect(mockRecordingProps).toBeUndefined();
  await act(async () => { cleanup.resolve(); });
  await waitFor(() => expect(mockRecordingProps?.purpose).toBe('reference'));
  await act(async () => { await mockRecordingProps!.onAttach(preparedReference, {
    uri: 'file:///test-cache/recording.m4a', container: 'm4a', byteSize: 4096,
    durationMillis: 1000, recorderId: 'owner', requestId: 1,
  }, { assertCurrent: () => undefined }); mockRecordingProps!.onClose(); });
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(referenceVoiceStore.save).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('tts-reference-consent'));
  await waitFor(() => expect(view.getByTestId('tts-synthesize')).toBeEnabled());
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({
    voice: { kind: 'reference', bake: 'eager', source: { kind: 'temporary',
      sourceUri: 'file:///test-cache/audio-reference/immutable.wav', sourceSha256: 'a'.repeat(64), durationMs: 1000, consent: true } },
  })));
  expect(referenceVoiceStore.save).not.toHaveBeenCalled();
});

it('does not open an audio picker after close invalidates a deferred initial cleanup', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  const options = props();
  const view = renderSheet(options);
  fireEvent.press(view.getByTestId('tts-reference-import'));
  fireEvent.press(view.getByTestId('tts-close'));
  await act(async () => { cleanup.resolve(); });
  await waitFor(() => expect(options.onClose).toHaveBeenCalled());
  expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();
  expect(prepareManagedAudio).not.toHaveBeenCalled();
});

it.each(['record', 'import'] as const)('does not open stale reference %s after selection changes during initial audio drain', async action => {
  mockSelection = { profileId: 'qwen3-tts', modelName: 'Original', languages: ['en'], voiceModes: ['reference'] };
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  const view = renderSheet(props());
  fireEvent.press(view.getByTestId('tts-reference-' + action));
  await act(async () => {
    mockSelection = { profileId: 'outetts-1.0', modelName: 'Changed', languages: ['en'], voiceModes: ['speakerless'] };
    mockSettingsListeners.forEach(listener => listener());
  });
  await act(async () => { cleanup.resolve(); });
  expect(view.queryByTestId('reference-recording-sheet')).toBeNull();
  expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();
});

it('drains a late reference preparation on unmount and disposes its derivative without starting playback', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const temporary = temporaryReference();
  jest.mocked(referenceVoiceStore.retainTemporarySource).mockResolvedValueOnce(temporary);
  const view = renderSheet(props());
  await useRecordedReference(view);
  const preparation = deferred<PreparedAudio>();
  jest.mocked(prepareManagedAudio).mockReturnValueOnce(preparation.promise);
  fireEvent.press(view.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(prepareManagedAudio).toHaveBeenCalled());
  jest.mocked(waitForAudioPreparationDrain).mockReturnValueOnce(preparation.promise.then(() => undefined));
  view.unmount();
  expect(temporary.release).not.toHaveBeenCalled();
  await act(async () => { preparation.resolve(preparedReference); });
  await waitFor(() => expect(temporary.release).toHaveBeenCalled());
  expect(discardPreparedAudio).toHaveBeenCalledWith(preparedReference);
  expect(audioSamplePreviewService.play).not.toHaveBeenCalled();
});

it('stops a reference preview and confirms player disposal before deleting its derivative', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const view = renderSheet(props());
  await useRecordedReference(view);
  fireEvent.press(view.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(audioSamplePreviewService.play).toHaveBeenCalled());
  await act(async () => { mockSampleState = { phase: 'playing' }; mockSampleListeners.forEach(listener => listener()); });
  const disposal = deferred();
  jest.mocked(audioSamplePreviewService.stop).mockReturnValueOnce(disposal.promise);
  fireEvent.press(view.getByTestId('tts-reference-preview-stop'));
  expect(discardPreparedAudio).not.toHaveBeenCalled();
  await act(async () => { disposal.resolve(); });
  await waitFor(() => expect(discardPreparedAudio).toHaveBeenCalledWith(preparedReference));
});

it('keeps reference Stop usable during deferred native Starting and drains before derivative deletion', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const view = renderSheet(props());
  await useRecordedReference(view);
  const starting = deferred(), disposal = deferred();
  jest.mocked(audioSamplePreviewService.play).mockReturnValueOnce(starting.promise);
  fireEvent.press(view.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(audioSamplePreviewService.play).toHaveBeenCalled());
  await act(async () => { mockSampleState = { phase: 'starting' }; mockSampleListeners.forEach(listener => listener()); });
  const owner = jest.mocked(audioSamplePreviewService.play).mock.calls[0][0].ownerKey;
  const stop = view.getByTestId('tts-reference-preview-stop');
  expect(stop).toBeEnabled();
  jest.mocked(audioSamplePreviewService.stop).mockReturnValueOnce(disposal.promise);
  fireEvent.press(stop);
  expect(audioSamplePreviewService.stop).toHaveBeenLastCalledWith(owner);
  expect(discardPreparedAudio).not.toHaveBeenCalled();
  expect(view.getByTestId('tts-reference-preview')).toBeDisabled();
  await act(async () => { starting.resolve(); disposal.resolve(); });
  await waitFor(() => expect(discardPreparedAudio).toHaveBeenCalledWith(preparedReference));
});

it('invalidates reference preview preparation on model selection change and discards the late result', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const view = renderSheet(props());
  await useRecordedReference(view);
  const preparation = deferred<PreparedAudio>();
  jest.mocked(prepareManagedAudio).mockReturnValueOnce(preparation.promise);
  fireEvent.press(view.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(prepareManagedAudio).toHaveBeenCalled());
  const operation = jest.mocked(prepareManagedAudio).mock.calls[0][0];
  jest.mocked(waitForAudioPreparationDrain).mockReturnValueOnce(preparation.promise.then(() => undefined));
  await act(async () => { mockSelection = { ...mockSelection, modelName: 'Changed model' }; mockSettingsListeners.forEach(listener => listener()); });
  expect(() => operation.assertCurrent?.()).toThrow();
  await act(async () => { preparation.resolve(preparedReference); });
  await waitFor(() => expect(discardPreparedAudio).toHaveBeenCalledWith(preparedReference));
  expect(audioSamplePreviewService.play).not.toHaveBeenCalled();
});

it('releases the prior immutable temporary source before retaining a replacement', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const previous = temporaryReference();
  jest.mocked(referenceVoiceStore.retainTemporarySource).mockResolvedValueOnce(previous);
  const view = renderSheet(props());
  await useRecordedReference(view);
  const release = deferred();
  jest.mocked(previous.release).mockReturnValueOnce(release.promise);
  fireEvent.press(view.getByTestId('tts-reference-record'));
  await waitFor(() => expect(view.getByTestId('reference-recording-sheet')).toBeTruthy());
  let attach!: Promise<void>;
  act(() => { attach = mockRecordingProps!.onAttach(preparedReference, {
    uri: 'file:///test-cache/recording-second.m4a', container: 'm4a', byteSize: 4096,
    durationMillis: 1000, recorderId: 'second-owner', requestId: 2,
  }, { assertCurrent: () => undefined }); });
  await waitFor(() => expect(previous.release).toHaveBeenCalled());
  expect(referenceVoiceStore.retainTemporarySource).toHaveBeenCalledTimes(1);
  await act(async () => { release.resolve(); await attach; });
  expect(referenceVoiceStore.retainTemporarySource).toHaveBeenCalledTimes(2);
});

it('requires explicit Save and drains synthesis before deleting a saved voice', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const view = renderSheet(props());
  await useRecordedReference(view);
  fireEvent.press(view.getByTestId('tts-save-options'));
  fireEvent.changeText(view.getByTestId('tts-reference-name'), 'Allowed sample');
  expect(view.getByTestId('tts-reference-save')).toBeDisabled();
  fireEvent.press(view.getByTestId('tts-reference-consent'));
  await waitFor(() => expect(view.getByTestId('tts-reference-save')).toBeEnabled());
  const savedVoice = { id: 'saved-voice', name: 'Allowed sample', sourceSha256: 'a'.repeat(64),
    sourceBytes: 4096, durationMs: 1000, sourceMimeType: 'audio/wav' as const, createdAt: 1, consentRecordedAt: 1 };
  jest.mocked(referenceVoiceStore.save).mockResolvedValueOnce(savedVoice);
  fireEvent.press(view.getByTestId('tts-reference-save'));
  await waitFor(() => expect(referenceVoiceStore.save).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Allowed sample', consent: true, sourceUri: 'file:///test-cache/audio-reference/immutable.wav',
  }), { assertCurrent: expect.any(Function) }));
  await act(async () => { mockSavedState = { voices: [savedVoice], selectedVoiceId: savedVoice.id }; mockSavedListeners.forEach(listener => listener()); });
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  fireEvent.press(view.getByTestId('tts-delete-saved-voice'));
  expect(referenceVoiceStore.delete).not.toHaveBeenCalled();
  await act(async () => { cleanup.resolve(); });
  await waitFor(() => expect(referenceVoiceStore.delete).toHaveBeenCalledWith(savedVoice.id));
});

it('scopes a closed reference sheet delayed preview cleanup to its owner after another sheet previews', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const previous = renderSheet(props());
  await useRecordedReference(previous);
  fireEvent.press(previous.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(audioSamplePreviewService.play).toHaveBeenCalledTimes(1));
  const previousOwner = jest.mocked(audioSamplePreviewService.play).mock.calls[0][0].ownerKey;
  expect(previousOwner).toBeTruthy();
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  previous.unmount();
  const next = renderSheet(props());
  await useRecordedReference(next);
  fireEvent.press(next.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(audioSamplePreviewService.play).toHaveBeenCalledTimes(2));
  const nextOwner = jest.mocked(audioSamplePreviewService.play).mock.calls[1][0].ownerKey;
  expect(nextOwner).not.toBe(previousOwner);
  await act(async () => { cleanup.resolve(); });
  await waitFor(() => expect(audioSamplePreviewService.stop).toHaveBeenLastCalledWith(previousOwner));
});

it('fails closed on uncertain reference preparation cleanup instead of offering a preview retry', async () => {
  mockSelection = { profileId: 'qwen3-tts', languages: ['en'], voiceModes: ['reference'] };
  const options = props();
  const view = renderSheet(options);
  await useRecordedReference(view);
  jest.mocked(prepareManagedAudio).mockRejectedValueOnce(Object.assign(new Error('private preparation cleanup'), { code: 'cleanup_failed' }));
  fireEvent.press(view.getByTestId('tts-reference-preview'));
  await waitFor(() => expect(options.onCleanupFailure).toHaveBeenCalled());
  expect(view.getByTestId('tts-reference-preview')).toBeDisabled();
  expect(view.getByTestId('tts-reference-import')).toBeDisabled();
  expect(view.getByTestId('tts-error').props.children).toBe('tts.errors.storage_failed');
  expect(audioSamplePreviewService.play).not.toHaveBeenCalled();
});

it('keeps voice management and advanced settings collapsed until explicitly opened', () => {
  mockSelection = { ...mockSelection, voiceModes: ['speakerless', 'reference'] };
  const view = render(<TtsPreviewSheet {...props()} />);
  expect(view.getByTestId('tts-text-input')).toBeTruthy();
  expect(view.getByTestId('tts-synthesize')).toBeEnabled();
  expect(view.queryByTestId('tts-reference-record')).toBeNull();
  expect(view.queryByTestId('tts-check-files')).toBeNull();
  expect(service.start).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('tts-voice-options'));
  fireEvent.press(view.getByTestId('tts-mode-reference'));
  expect(view.getByTestId('tts-reference-record')).toBeTruthy();
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  fireEvent.press(view.getByTestId('tts-advanced-toggle'));
  expect(view.getByTestId('tts-bake-eager')).toBeTruthy();
});

it('shows unknown language keys without relabeling or normalizing their payload', async () => {
  mockSelection = { ...mockSelection, languages: ['en-us'] };
  const view = renderSheet(props());
  expect(view.getByTestId('tts-language-en-us')).toHaveTextContent('en-us');
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalled());
  expect(service.start.mock.calls[0][0].language).toBe('en-us');
});

it('opens Models directly from a missing-model summary without revealing empty voice settings', async () => {
  mockSelection = { languages: [], errorCode: 'selection_missing' };
  const onOpenModels = jest.fn();
  const view = render(<TtsPreviewSheet {...props({ onOpenModels })} />);
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  fireEvent.press(view.getByTestId('tts-voice-options'));
  await waitFor(() => expect(onOpenModels).toHaveBeenCalledTimes(1));
  expect(view.queryByTestId('tts-voice-options-content')).toBeNull();
  expect(view.getByTestId('tts-use-recommended-voice')).toBeTruthy();
  expect(mockStartRecommended).not.toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
});

it('starts recommended setup only from its explicit button without starting speech', async () => {
  const view = renderSheet(props());
  expect(view.getByTestId('tts-use-recommended-voice')).toHaveTextContent('tts.setup.download');
  expect(mockStartRecommended).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('tts-use-recommended-voice'));
  await waitFor(() => expect(mockStartRecommended).toHaveBeenCalledTimes(1));
  expect(mockStartRecommended.mock.calls[0][0]()).toBe(true);
  expect(service.cancelAndClear).toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
});

it('offers Use for an already installed recommended voice', () => {
  mockRecommendedInstalled = true;
  const view = renderSheet(props());
  expect(view.getByTestId('tts-use-recommended-voice')).toHaveTextContent('tts.setup.use');
  expect(mockStartRecommended).not.toHaveBeenCalled();
});

it('offers the explicit download from missing-model recovery while retaining Models', async () => {
  mockSelection = { languages: [], errorCode: 'selection_missing' };
  const options = props();
  const view = render(<TtsPreviewSheet {...options} />);
  expect(view.getByTestId('tts-use-recommended-voice')).toBeEnabled();
  expect(view.getByTestId('tts-error-models')).toBeTruthy();
  fireEvent.press(view.getByTestId('tts-use-recommended-voice'));
  await waitFor(() => expect(mockStartRecommended).toHaveBeenCalledTimes(1));
  expect(options.onOpenModels).not.toHaveBeenCalled();
  expect(service.start).not.toHaveBeenCalled();
});

it('offers recommended setup when a runtime file check reports missing files', () => {
  mockState = { phase: 'error', errorCode: 'files_missing' };
  const view = render(<TtsPreviewSheet {...props()} />);
  expect(view.getByTestId('tts-use-recommended-voice')).toBeEnabled();
  expect(view.getByTestId('tts-error-models')).toBeTruthy();
  expect(mockStartRecommended).not.toHaveBeenCalled();
});

it('shows setup progress and cancellation and blocks synthesis until setup completes', async () => {
  mockSetupState = { phase: 'downloading_codec', progress: 0.85 };
  const view = render(<TtsPreviewSheet {...props()} />);
  expect(view.getByTestId('tts-setup-phase')).toHaveTextContent('tts.setup.phases.downloading_codec · tts.setup.progress');
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(view.queryByTestId('tts-use-recommended-voice')).toBeNull();
  fireEvent.press(view.getByTestId('tts-cancel-model-setup'));
  await waitFor(() => expect(mockCancelModelSetup).toHaveBeenCalledTimes(1));
});

it('invalidates its setup guard immediately and waits for setup drain before closing', async () => {
  const options = props();
  const view = renderSheet(options);
  fireEvent.press(view.getByTestId('tts-use-recommended-voice'));
  await waitFor(() => expect(mockStartRecommended).toHaveBeenCalledTimes(1));
  const guard = mockStartRecommended.mock.calls[0][0];
  const drain = deferred(); mockCancelModelSetup.mockReturnValueOnce(drain.promise);
  fireEvent.press(view.getByTestId('tts-close'));
  expect(guard()).toBe(false); expect(options.onClose).not.toHaveBeenCalled();
  await act(async () => { drain.resolve(); });
  await waitFor(() => expect(options.onClose).toHaveBeenCalledTimes(1));
});

it('waits for setup cancellation before closing even when audio cleanup rejects first', async () => {
  const options = props();
  const view = render(<TtsPreviewSheet {...options} />);
  const drain = deferred();
  mockCancelModelSetup.mockReturnValueOnce(drain.promise);
  service.cancelAndClear.mockRejectedValueOnce(new Error('audio cleanup failed'));
  fireEvent.press(view.getByTestId('tts-close'));
  await act(async () => { await Promise.resolve(); });
  expect(mockCancelModelSetup).toHaveBeenCalledTimes(1);
  expect(options.onClose).not.toHaveBeenCalled();
  await act(async () => { drain.resolve(); });
  await waitFor(() => expect(options.onClose).toHaveBeenCalledTimes(1));
  expect(options.onCleanupFailure).toHaveBeenCalled();
});

it('cancels its setup owner when the sheet unmounts', async () => {
  const view = render(<TtsPreviewSheet {...props()} />);
  view.unmount();
  await waitFor(() => expect(mockCancelModelSetup).toHaveBeenCalledTimes(1));
});

it('reports uncertain setup cleanup and disables further speech actions', async () => {
  mockSetupState = { phase: 'downloading_model', progress: 0.1 };
  mockCancelModelSetup.mockRejectedValueOnce({ code: 'cleanup_failed' });
  const options = props(); const view = render(<TtsPreviewSheet {...options} />);
  fireEvent.press(view.getByTestId('tts-cancel-model-setup'));
  await waitFor(() => expect(options.onCleanupFailure).toHaveBeenCalled());
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(view.getByTestId('tts-error')).toHaveTextContent('tts.errors.storage_failed');
});

it('localizes setup stages and failures in English and Russian', () => {
  expect(Object.keys(en.tts.setup.phases)).toEqual(Object.keys(ru.tts.setup.phases));
  expect(Object.keys(en.tts.setup.errors)).toEqual(Object.keys(ru.tts.setup.errors));
  for (const messages of [en.tts.setup, ru.tts.setup]) {
    expect(messages.download).toContain('{{mib}}');
    expect(messages.progress).toContain('{{percent}}');
    expect(Object.values(messages.phases).every(value => value.length > 0)).toBe(true);
    expect(Object.values(messages.errors).every(value => value.length > 0)).toBe(true);
  }
});

it('exposes the checked builtin radio state to assistive technology', async () => {
  mockSelection = { ...mockSelection, voiceModes: ['builtin'], builtinVoices: ['dave', 'jo'] };
  const view = renderSheet(props());
  expect(view.getByTestId('tts-builtin-dave').props.accessibilityState.checked).toBe(true);
  expect(view.getByTestId('tts-builtin-jo').props.accessibilityState.checked).toBe(false);
  fireEvent.press(view.getByTestId('tts-builtin-jo'));
  await waitFor(() => expect(view.getByTestId('tts-builtin-jo').props.accessibilityState.checked).toBe(true));
  expect(view.getByTestId('tts-builtin-dave').props.accessibilityState.checked).toBe(false);
});
