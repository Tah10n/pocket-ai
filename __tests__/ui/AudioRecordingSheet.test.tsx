import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AudioRecordingSheet } from '../../src/components/ui/AudioRecordingSheet';
import { audioRecordingService, type AudioRecordingState, type RecordedAudio } from '../../src/services/AudioRecordingService';
import { prepareManagedAudio, discardPreparedAudio, type PreparedAudio } from '../../src/services/AudioPreparationService';
import { audioSamplePreviewService } from '../../src/services/AudioSamplePreviewService';
import en from '../../src/i18n/locales/en.json';
import ru from '../../src/i18n/locales/ru.json';

jest.mock('react-native-css-interop', () => { const mockReact = require('react'); return { createInteropElement: mockReact.createElement }; });
jest.mock('../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react'), { View } = require('react-native');
  const Container = ({ children, ...props }: any) => mockReact.createElement(View, props, children);
  return { ScreenModalOverlay: Container, ScreenSheet: Container };
});
let mockState: AudioRecordingState = { phase: 'idle', durationMillis: 0 };
const mockListeners = new Set<() => void>();
jest.mock('../../src/services/AudioRecordingService', () => ({ audioRecordingService: {
  getState: () => mockState,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
  start: jest.fn(), stop: jest.fn(), cancelAndClear: jest.fn(), onBackground: jest.fn(),
} }));
jest.mock('../../src/services/AudioPreparationService', () => ({ prepareManagedAudio: jest.fn(), discardPreparedAudio: jest.fn() }));
const mockPreviewState = { phase: 'stopped', position: 0, duration: 0 };
jest.mock('../../src/services/AudioSamplePreviewService', () => ({ audioSamplePreviewService: {
  getState: () => mockPreviewState,
  subscribe: () => () => undefined, play: jest.fn(), stop: jest.fn(),
} }));
const source: RecordedAudio = { uri: 'file:///cache/recording.m4a', byteSize: 1024, durationMillis: 1000,
  container: 'm4a', recorderId: 'native-recorder-1', requestId: 1 };
const audio: PreparedAudio = { uri: 'file:///cache/audio-preparation/123.wav', sourceSha256: 'a'.repeat(64),
  identity: 'prepared-v1', sampleRate: 16_000, channels: 1, sampleCount: 16_000, durationMs: 1000, sizeBytes: 32_044 };
function emit(phase: AudioRecordingState['phase'], recording?: RecordedAudio) {
  const request = jest.mocked(audioRecordingService.start).mock.calls.at(-1)?.[0];
  mockState = { phase, ownerKey: request?.ownerKey, purpose: request?.purpose ?? 'chat', durationMillis: 1000, ...(recording ? { recording } : {}) };
  mockListeners.forEach(listener => listener());
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
function props(overrides: Partial<React.ComponentProps<typeof AudioRecordingSheet>> = {}) {
  return { ownerKey: 'chat-a', purpose: 'chat' as const, onAttach: jest.fn(async () => undefined),
    onClose: jest.fn(), onCleanupFailure: jest.fn(), ...overrides };
}
async function primeRecorder(view: ReturnType<typeof render>, phase: AudioRecordingState['phase'], recording?: RecordedAudio) {
  fireEvent.press(view.getByTestId('audio-record'));
  await waitFor(() => expect(audioRecordingService.start).toHaveBeenCalled());
  await act(async () => { emit(phase, recording); });
}
let background: ((state: string) => void) | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockState = { phase: 'idle', durationMillis: 0 };
  mockListeners.clear();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    background = listener as (state: string) => void;
    return { remove: jest.fn() };
  });
  jest.mocked(audioRecordingService.start).mockResolvedValue(undefined);
  jest.mocked(audioRecordingService.stop).mockResolvedValue(source);
  jest.mocked(audioRecordingService.cancelAndClear).mockResolvedValue(undefined);
  jest.mocked(audioRecordingService.onBackground).mockResolvedValue(undefined);
  jest.mocked(prepareManagedAudio).mockResolvedValue(audio);
  jest.mocked(discardPreparedAudio).mockResolvedValue(undefined);
  jest.mocked(audioSamplePreviewService.play).mockResolvedValue(undefined);
  jest.mocked(audioSamplePreviewService.stop).mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

it('opens without requesting a microphone or preparing audio and permits independent reference recording', async () => {
  const view = render(<AudioRecordingSheet {...props({ purpose: 'reference' })} />);
  expect(audioRecordingService.start).not.toHaveBeenCalled();
  expect(prepareManagedAudio).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('audio-record'));
  await waitFor(() => expect(audioRecordingService.start).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'reference', ownerKey: expect.stringContaining('chat-a:recording-sheet:') })));
});

it('shows native Starting separately and Stop invalidates a pending real recorder request', async () => {
  const start = deferred<void>();
  jest.mocked(audioRecordingService.start).mockImplementation(() => { emit('starting'); return start.promise; });
  const view = render(<AudioRecordingSheet {...props()} />);
  fireEvent.press(view.getByTestId('audio-record'));
  await waitFor(() => expect(view.getByTestId('audio-recording-phase').props.children).toBe('audioRecording.phases.starting'));
  expect(view.queryByTestId('audio-record-attach')).toBeNull();
  const request = jest.mocked(audioRecordingService.start).mock.calls[0][0];
  fireEvent.press(view.getByTestId('audio-record-stop'));
  expect(request.isCurrent?.()).toBe(false);
  expect(audioRecordingService.stop).toHaveBeenCalled();
  await act(async () => { start.resolve(); });
});

it('waits for actual Stop/finalization before preparation, then Preview and Attach remain explicit', async () => {
  const stopped = deferred<RecordedAudio | null>();
  jest.mocked(audioRecordingService.stop).mockReturnValue(stopped.promise);
  const attach = jest.fn(async () => undefined);
  const view = render(<AudioRecordingSheet {...props({ onAttach: attach })} />);
  await primeRecorder(view, 'recording');
  fireEvent.press(view.getByTestId('audio-record-stop'));
  await act(async () => { await Promise.resolve(); });
  expect(prepareManagedAudio).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
  await act(async () => { stopped.resolve(source); emit('ready', source); });
  await waitFor(() => expect(prepareManagedAudio).toHaveBeenCalledWith(expect.objectContaining({ sourceUri: source.uri, purpose: 'chat' })));
  expect(attach).not.toHaveBeenCalled();
  fireEvent.press(view.getByTestId('audio-record-preview'));
  await waitFor(() => expect(audioSamplePreviewService.play).toHaveBeenCalledWith(expect.objectContaining({ uri: audio.uri, sampleCount: 16_000 })));
  fireEvent.press(view.getByTestId('audio-record-attach'));
  await waitFor(() => expect(attach).toHaveBeenCalledWith(audio, source, { assertCurrent: expect.any(Function) }));
  await waitFor(() => expect(audioRecordingService.cancelAndClear).toHaveBeenCalled());
});

it('Discard invalidates an in-flight Attach before the caller commits and waits for its drain', async () => {
  const copying = deferred<void>();
  let assertCurrent!: () => void;
  let committed = false;
  const options = props({ onAttach: async (_audio, _source, operation) => {
    assertCurrent = operation.assertCurrent;
    await copying.promise;
    assertCurrent();
    committed = true;
  } });
  const view = render(<AudioRecordingSheet {...options} />);
  await primeRecorder(view, 'ready', source);
  fireEvent.press(view.getByTestId('audio-record-attach'));
  await waitFor(() => expect(assertCurrent).toBeDefined());
  fireEvent.press(view.getByTestId('audio-record-discard'));
  expect(() => assertCurrent()).toThrow('cancelled');
  expect(options.onClose).not.toHaveBeenCalled();
  await act(async () => { copying.resolve(); });
  await waitFor(() => expect(options.onClose).toHaveBeenCalled());
  expect(committed).toBe(false);
  expect(discardPreparedAudio).toHaveBeenCalledWith(audio);
});

it('closing during preprocessing waits for its real drain before deleting the recorder source', async () => {
  const preparing = deferred<PreparedAudio>();
  jest.mocked(prepareManagedAudio).mockReturnValue(preparing.promise);
  const options = props();
  const view = render(<AudioRecordingSheet {...options} />);
  await primeRecorder(view, 'ready', source);
  fireEvent.press(view.getByTestId('audio-record-preview'));
  await waitFor(() => expect(prepareManagedAudio).toHaveBeenCalled());
  fireEvent.press(view.getByTestId('audio-record-discard'));
  expect(jest.mocked(prepareManagedAudio).mock.calls[0][0].signal?.aborted).toBe(true);
  expect(audioRecordingService.cancelAndClear).not.toHaveBeenCalled();
  expect(options.onClose).not.toHaveBeenCalled();
  await act(async () => { preparing.resolve(audio); });
  await waitFor(() => expect(options.onClose).toHaveBeenCalled());
  expect(discardPreparedAudio).toHaveBeenCalledWith(audio);
  expect(audioRecordingService.cancelAndClear).toHaveBeenCalled();
});

it('background stops the real recorder/preview and returning never restarts capture', async () => {
  const view = render(<AudioRecordingSheet {...props()} />);
  await primeRecorder(view, 'recording');
  act(() => background?.('background'));
  await waitFor(() => expect(audioRecordingService.onBackground).toHaveBeenCalled());
  act(() => background?.('active'));
  expect(audioRecordingService.start).toHaveBeenCalledTimes(1);
  expect(audioSamplePreviewService.stop).toHaveBeenCalled();
});

it('scopes delayed cleanup to its exact recorder and sample preview rather than a newly opened sheet', async () => {
  const previous = render(<AudioRecordingSheet {...props()} />);
  await primeRecorder(previous, 'ready', source);
  const previousOwner = jest.mocked(audioRecordingService.start).mock.calls[0][0].ownerKey;
  fireEvent.press(previous.getByTestId('audio-record-preview'));
  await waitFor(() => expect(audioSamplePreviewService.play).toHaveBeenCalled());
  expect(jest.mocked(audioSamplePreviewService.play).mock.calls[0][0].ownerKey).toBe(previousOwner);
  const disposal = deferred<void>();
  jest.mocked(audioSamplePreviewService.stop).mockReturnValueOnce(disposal.promise);
  previous.unmount();
  expect(audioSamplePreviewService.stop).toHaveBeenLastCalledWith(previousOwner);
  const next = render(<AudioRecordingSheet {...props()} />);
  fireEvent.press(next.getByTestId('audio-record'));
  await waitFor(() => expect(audioRecordingService.start).toHaveBeenCalledTimes(2));
  const nextOwner = jest.mocked(audioRecordingService.start).mock.calls[1][0].ownerKey;
  expect(nextOwner).not.toBe(previousOwner);
  await act(async () => { disposal.resolve(); });
  await waitFor(() => expect(audioRecordingService.cancelAndClear).toHaveBeenCalledWith(previousOwner));
  expect(audioRecordingService.cancelAndClear).not.toHaveBeenCalledWith(nextOwner);
});

it('latches uncertain preparation cleanup and blocks preview/Attach retries', async () => {
  const options = props();
  const view = render(<AudioRecordingSheet {...options} />);
  await primeRecorder(view, 'ready', source);
  jest.mocked(prepareManagedAudio).mockRejectedValueOnce(Object.assign(new Error('private native cleanup details'), { code: 'cleanup_failed' }));
  fireEvent.press(view.getByTestId('audio-record-preview'));
  await waitFor(() => expect(options.onCleanupFailure).toHaveBeenCalled());
  expect(view.getByTestId('audio-record-preview')).toBeDisabled();
  expect(view.getByTestId('audio-record-attach')).toBeDisabled();
  expect(view.getByTestId('audio-recording-error').props.children).toBe('audioRecording.errors.cleanup_failed');
  fireEvent.press(view.getByTestId('audio-record-preview'));
  expect(prepareManagedAudio).toHaveBeenCalledTimes(1);
});

it('localizes every recorder phase and native failure in both languages', () => {
  for (const locale of [en, ru]) {
    for (const phase of ['idle', 'requesting-permission', 'preparing', 'starting', 'recording', 'finalizing', 'ready', 'error', 'preparing_audio']) {
      expect((locale.audioRecording.phases as Record<string, string>)[phase]).toBeTruthy();
    }
    for (const code of ['permission_denied', 'permission_permanently_denied', 'prepare_failed', 'start_failed', 'finalize_failed', 'file_invalid', 'release_failed', 'storage_failed']) {
      expect((locale.audioRecording.errors as Record<string, string>)[code]).toBeTruthy();
    }
  }
});
