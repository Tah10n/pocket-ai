import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { TtsPreviewSheet } from '../../src/components/ui/TtsPreviewSheet';
import { ttsService } from '../../src/services/TtsService';
import en from '../../src/i18n/locales/en.json';
import ru from '../../src/i18n/locales/ru.json';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return { createInteropElement: mockReact.createElement };
});
jest.mock('../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react'), { View } = require('react-native');
  const Container = ({ children, ...props }: any) => mockReact.createElement(View, props, children);
  return { ScreenModalOverlay: Container, ScreenSheet: Container };
});
const mockSettingsListeners = new Set<() => void>();
jest.mock('../../src/services/SettingsStore', () => ({ subscribeSettings: (listener: () => void) => {
  mockSettingsListeners.add(listener); return () => mockSettingsListeners.delete(listener);
} }));
jest.mock('../../src/services/LocalStorageRegistry', () => ({ registry: { subscribeModels: () => () => undefined } }));

let mockSelection = { profileId: 'outetts-1.0', modelName: 'Oute', languages: ['en'], requiredBytes: 1 };
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function props(overrides: Partial<React.ComponentProps<typeof TtsPreviewSheet>> = {}) {
  return { initialText: 'The blue door is open.', isPreviewCurrent: () => true,
    onClose: jest.fn(), onOpenModels: jest.fn(), onCleanupFailure: jest.fn(), ...overrides };
}
beforeEach(() => {
  mockSelection = { profileId: 'outetts-1.0', modelName: 'Oute', languages: ['en'], requiredBytes: 1 };
  mockState = { phase: null };
  mockListeners.clear();
  mockSettingsListeners.clear();
  jest.clearAllMocks();
  for (const method of ['start', 'checkFiles', 'cancelAndClear', 'play', 'pause', 'replay', 'stop'] as const) {
    service[method].mockResolvedValue(undefined);
  }
});

it('keeps file checking separate from speech and submits only the exact visible preview', async () => {
  const source = { threadId: 'thread', messageId: 'answer' };
  const view = render(<TtsPreviewSheet {...props({ source })} />);
  expect(service.start).not.toHaveBeenCalled();
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
  const view = render(<TtsPreviewSheet {...props()} />);
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
  const view = render(<TtsPreviewSheet {...props()} />);
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
  const view = render(<TtsPreviewSheet {...props({ initialText: text, reviewReason: 'structured' })} />);
  expect(view.getByTestId('tts-exact-preview').props.children).toBe(text);
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  fireEvent.press(view.getByTestId('tts-confirm-review'));
  fireEvent.press(view.getByTestId('tts-synthesize'));
  await waitFor(() => expect(service.start).toHaveBeenCalledTimes(1));
  expect(service.start.mock.calls[0][0].text).toBe(text);
});

it('rejects protocol and private paths without exposing them as a speech request', () => {
  const view = render(<TtsPreviewSheet {...props({ initialText: 'file:///data/user/0/private.wav' })} />);
  expect(view.getByTestId('tts-error').props.children).toBe('tts.errors.unsafe_content');
  expect(view.getByTestId('tts-synthesize')).toBeDisabled();
  expect(service.start).not.toHaveBeenCalled();
});

it('replays a ready clip without invoking synthesis', async () => {
  mockState = { phase: 'ready', sampleCount: 24000, duration: 1, position: 0 };
  const view = render(<TtsPreviewSheet {...props()} />);
  fireEvent.press(view.getByTestId('tts-replay'));
  await waitFor(() => expect(service.replay).toHaveBeenCalledTimes(1));
  expect(service.start).not.toHaveBeenCalled();
});

it('closes only after clearing and draining the player/native owner', async () => {
  const cleanup = deferred();
  service.cancelAndClear.mockReturnValueOnce(cleanup.promise);
  const onClose = jest.fn();
  const view = render(<TtsPreviewSheet {...props({ onClose })} />);
  fireEvent.press(view.getByTestId('tts-close'));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { cleanup.resolve(); await cleanup.promise; });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('keeps stable restoration current after close/unmount while deferred cleanup blocks late playback', async () => {
  const synthesis = deferred(), cleanup = deferred();
  service.start.mockReturnValueOnce(synthesis.promise);
  let visible = true;
  const view = render(<TtsPreviewSheet {...props({ isPreviewCurrent: () => visible })} />);
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
  const view = render(<TtsPreviewSheet {...props()} />);
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
  const view = render(<TtsPreviewSheet {...props({ onCleanupFailure })} />);
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
  const view = render(<TtsPreviewSheet {...props()} />);
  expect(view.getByTestId('tts-error').props.children).toBe('tts.errors.' + errorCode);
  expect(view.getByTestId('tts-phase').props.children).toBe('tts.phases.error');
  expect(view.getByTestId('tts-play')).toBeEnabled();
  fireEvent.press(view.getByTestId('tts-play'));
  await waitFor(() => expect(service.play).toHaveBeenCalledTimes(1));
  expect(service.start).not.toHaveBeenCalled();
});

it('keeps pending native startup separate from Playing and Stop available', () => {
  mockState = { phase: 'starting', sampleCount: 24000, clipAvailable: true };
  const view = render(<TtsPreviewSheet {...props()} />);
  expect(view.getByTestId('tts-phase').props.children).toBe('tts.phases.starting');
  expect(view.queryByTestId('tts-pause')).toBeNull();
  expect(view.getByTestId('tts-stop')).toBeTruthy();
});
