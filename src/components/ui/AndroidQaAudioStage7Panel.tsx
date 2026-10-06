import React, { useState, useSyncExternalStore } from 'react';
import { Modal } from 'react-native';
import { Box } from './box';
import { Text } from './text';
import { Button, ButtonText } from './button';
import { audioRecordingService } from '../../services/AudioRecordingService';
import { isAndroidQaAudioStage7Enabled, getAndroidQaAudioStage7Evidence, subscribeAndroidQaAudioStage7,
  runAndroidQaStage7Recording, runAndroidQaStage7Input, runAndroidQaStage7Voices, checkAndroidQaStage7ColdVoice,
  continueAndroidQaAudioStage7 } from '../../services/AndroidQaAudioStage7';

/** Isolated developer QA controls follow the existing untranslated QA surface. */
export function AndroidQaAudioStage7Panel() {
  const [open, setOpen] = useState(false);
  const evidence = useSyncExternalStore(subscribeAndroidQaAudioStage7,
    getAndroidQaAudioStage7Evidence, getAndroidQaAudioStage7Evidence);
  const recording = useSyncExternalStore(audioRecordingService.subscribe,
    audioRecordingService.getState, audioRecordingService.getState);
  if (!isAndroidQaAudioStage7Enabled()) return null;
  const busy = evidence.status === 'running' || evidence.requiresForceStop;
  return <>
    <Button size="xs" action="secondary" testID="chat-qa-stage7-panel-toggle" onPress={() => setOpen(true)}>
      <ButtonText>QA Stage 7</ButtonText>
    </Button>
    <Modal visible={open} transparent animationType="none" onRequestClose={() => { if (!busy) setOpen(false); }}>
      <Box className="flex-1 justify-center bg-background-0/90 px-6">
        <Box className="gap-3 rounded-2xl border border-outline-200 bg-background-50 p-4">
          <Text colorRole="primary" className="text-lg font-semibold">QA Stage 7</Text>
          <Text colorRole="secondary" className="text-sm">{evidence.phase}</Text>
          <Box accessible collapsable={false} testID="chat-qa-stage7-evidence"
            accessibilityLabel={JSON.stringify(evidence)} className="h-1" />
          <Box accessible collapsable={false} testID="chat-qa-stage7-recording-state"
            accessibilityLabel={JSON.stringify({ phase: recording.phase,
              ownerKey: ['qa-stage7-recorder', 'qa-stage7-background'].includes(recording.ownerKey ?? '')
                ? recording.ownerKey : null, purpose: recording.purpose ?? null })} className="h-1" />
          <Button size="sm" action="secondary" testID="chat-qa-stage7-recording" disabled={busy}
            onPress={() => void runAndroidQaStage7Recording()}><ButtonText>QA controlled recording</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-stage7-input" disabled={busy}
            onPress={() => void runAndroidQaStage7Input()}><ButtonText>QA audio input content</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-stage7-voices" disabled={busy}
            onPress={() => void runAndroidQaStage7Voices()}><ButtonText>QA voices and phonemizer</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-stage7-cold-voice" disabled={busy}
            onPress={() => void checkAndroidQaStage7ColdVoice()}><ButtonText>QA cold voice and delete</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-stage7-continue"
            disabled={evidence.status !== 'running' || !evidence.phase.startsWith('recording_awaiting') && evidence.phase !== 'awaiting_clip_copy'}
            onPress={continueAndroidQaAudioStage7}><ButtonText>QA continue after host action</ButtonText></Button>
          <Button size="sm" action="secondary" testID="chat-qa-stage7-close" disabled={busy}
            onPress={() => setOpen(false)}><ButtonText>Close QA</ButtonText></Button>
        </Box>
      </Box>
    </Modal>
  </>;
}
