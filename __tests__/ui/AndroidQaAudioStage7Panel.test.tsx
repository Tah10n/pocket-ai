import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AndroidQaAudioStage7Panel } from '../../src/components/ui/AndroidQaAudioStage7Panel';
import { audioRecordingService, type AudioRecordingState } from '../../src/services/AudioRecordingService';
import { runAndroidQaStage7Recording } from '../../src/services/AndroidQaAudioStage7';

jest.mock('react-native-css-interop', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest factory resolves React after mock hoisting.
  const mockReact = require('react');
  return { createInteropElement: mockReact.createElement };
});
let mockEnabled = true;
const mockEvidence = { status: 'running', phase: 'recording_awaiting_controlled_sound', requiresForceStop: false };
jest.mock('../../src/services/AndroidQaAudioStage7', () => ({
  isAndroidQaAudioStage7Enabled: () => mockEnabled,
  getAndroidQaAudioStage7Evidence: () => mockEvidence,
  subscribeAndroidQaAudioStage7: () => () => undefined,
  runAndroidQaStage7Recording: jest.fn(), runAndroidQaStage7Input: jest.fn(),
  runAndroidQaStage7Voices: jest.fn(), checkAndroidQaStage7ColdVoice: jest.fn(),
  continueAndroidQaAudioStage7: jest.fn(),
}));
let mockRecording: AudioRecordingState = { phase: 'idle', durationMillis: 0 };
const mockListeners = new Set<() => void>();
jest.mock('../../src/services/AudioRecordingService', () => ({ audioRecordingService: {
  getState: () => mockRecording,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
  start: jest.fn(),
} }));

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled = true;
  mockRecording = { phase: 'idle', durationMillis: 0 };
  mockListeners.clear();
});

function openPanel() {
  const view = render(<AndroidQaAudioStage7Panel />);
  fireEvent.press(view.getByTestId('chat-qa-stage7-panel-toggle'));
  return view;
}
function emit(state: AudioRecordingState) {
  act(() => { mockRecording = state; mockListeners.forEach(listener => listener()); });
}

it('opens and subscribes without starting capture or requesting QA recording', () => {
  const view = openPanel();
  expect(audioRecordingService.start).not.toHaveBeenCalled();
  expect(runAndroidQaStage7Recording).not.toHaveBeenCalled();
  expect(JSON.parse(view.getByTestId('chat-qa-stage7-recording-state').props.accessibilityLabel))
    .toEqual({ phase: 'idle', ownerKey: null, purpose: null });
  view.unmount();
  expect(mockListeners.size).toBe(0);
});

it('publishes live native capture state independently of the host-action gate with no audio or file fields', () => {
  const view = openPanel();
  const marker = () => JSON.parse(view.getByTestId('chat-qa-stage7-recording-state').props.accessibilityLabel);
  emit({ phase: 'starting', ownerKey: 'qa-stage7-recorder', purpose: 'chat', durationMillis: 0 });
  expect(marker()).toEqual({ phase: 'starting', ownerKey: 'qa-stage7-recorder', purpose: 'chat' });
  expect(JSON.parse(view.getByTestId('chat-qa-stage7-evidence').props.accessibilityLabel).phase)
    .toBe('recording_awaiting_controlled_sound');
  emit({ phase: 'recording', ownerKey: 'qa-stage7-recorder', purpose: 'chat', durationMillis: 1234,
    recording: { uri: 'file:///private/cache/source.m4a', recorderId: 'private-handle', requestId: 42,
      byteSize: 2048, durationMillis: 1234, container: 'm4a' } });
  expect(marker()).toEqual({ phase: 'recording', ownerKey: 'qa-stage7-recorder', purpose: 'chat' });
  emit({ phase: 'finalizing', ownerKey: 'qa-stage7-recorder', purpose: 'chat', durationMillis: 1234 });
  expect(marker().phase).toBe('finalizing');
});

it('redacts ordinary consumer owner identities and hides the panel outside isolated QA', () => {
  const view = openPanel();
  emit({ phase: 'recording', ownerKey: 'private-chat-id:recording-sheet:7', purpose: 'reference', durationMillis: 100 });
  expect(JSON.parse(view.getByTestId('chat-qa-stage7-recording-state').props.accessibilityLabel))
    .toEqual({ phase: 'recording', ownerKey: null, purpose: 'reference' });
  view.unmount();
  mockEnabled = false;
  const disabled = render(<AndroidQaAudioStage7Panel />);
  expect(disabled.queryByTestId('chat-qa-stage7-panel-toggle')).toBeNull();
  expect(disabled.queryByTestId('chat-qa-stage7-recording-state')).toBeNull();
  expect(audioRecordingService.start).not.toHaveBeenCalled();
});
