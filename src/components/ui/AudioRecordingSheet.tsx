import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Modal, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { Text } from './text';
import { Pressable } from './pressable';
import { Button, ButtonText } from './button';
import { ScrollView } from './scroll-view';
import { ScreenCard, ScreenIconButton, ScreenModalOverlay, ScreenSheet } from './ScreenShell';
import { MaterialSymbols } from './MaterialSymbols';
import { audioRecordingService, type RecordedAudio } from '../../services/AudioRecordingService';
import { audioSamplePreviewService } from '../../services/AudioSamplePreviewService';
import { prepareManagedAudio, discardPreparedAudio, type PreparedAudio, type AudioPurpose } from '../../services/AudioPreparationService';

export interface AudioRecordingSheetProps {
  ownerKey: string;
  purpose: AudioPurpose;
  isCurrent?: () => boolean;
  /** Consume/copy both files before returning. This sheet releases its recorder source and derivative afterwards. */
  onAttach: (prepared: PreparedAudio, source: RecordedAudio, options: { assertCurrent: () => void }) => Promise<void>;
  onClose: () => void;
  onCleanupFailure?: () => void;
}
let sheetSequence = 0;

function recordingTime(durationMillis: number): string {
  const seconds = Math.floor(Number.isFinite(durationMillis) ? Math.max(0, durationMillis) / 1000 : 0);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** Shared recorder UI; selecting reference purpose never requires a chat-audio model. */
export function AudioRecordingSheet({ ownerKey, purpose, isCurrent, onAttach, onClose, onCleanupFailure }: AudioRecordingSheetProps) {
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  const [nativeOwnerKey] = useState(() => `${ownerKey}:recording-sheet:${++sheetSequence}`);
  const recorder = useSyncExternalStore(audioRecordingService.subscribe, audioRecordingService.getState, audioRecordingService.getState);
  const preview = useSyncExternalStore(audioSamplePreviewService.subscribe, audioSamplePreviewService.getState, audioSamplePreviewService.getState);
  const [pending, setPending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const current = useRef(true);
  const generation = useRef(0);
  const activeWork = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const prepared = useRef<PreparedAudio | null>(null);
  const previewRequested = useRef(false);
  const cleanup = useRef<Promise<void> | null>(null);
  const cleanupFailed = useRef(false);
  const currentCheck = useRef(isCurrent);
  const cleanupFailure = useRef(onCleanupFailure);
  currentCheck.current = isCurrent;
  cleanupFailure.current = onCleanupFailure;
  const ownsRecording = recorder.ownerKey === nativeOwnerKey && recorder.purpose === purpose;
  const source = ownsRecording ? recorder.recording : undefined;
  const phase = ownsRecording ? recorder.phase : 'idle';

  const flowCurrent = useCallback(() => current.current && mounted.current && AppState.currentState === 'active'
    && currentCheck.current?.() !== false, []);
  const clear = useCallback((): Promise<void> => {
    current.current = false;
    ++generation.current;
    controller.current?.abort();
    if (cleanup.current) return cleanup.current;
    const work = (async () => {
      // The current predicate already invalidates pending capture. Retain its file until preprocessing drains.
      await audioSamplePreviewService.stop(nativeOwnerKey);
      try { await activeWork.current; } catch { /* The action's sanitized failure is already shown. */ }
      if (prepared.current) { await discardPreparedAudio(prepared.current); prepared.current = null; }
      await audioRecordingService.cancelAndClear(nativeOwnerKey);
    })();
    cleanup.current = work;
    void work.catch(() => {
      cleanupFailed.current = true;
      if (mounted.current) setError('cleanup_failed');
      cleanupFailure.current?.();
    });
    return work;
  }, [nativeOwnerKey]);
  useEffect(() => {
    mounted.current = true;
    current.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      ++generation.current;
      controller.current?.abort();
      void audioSamplePreviewService.stop(nativeOwnerKey).catch(() => { cleanupFailed.current = true; cleanupFailure.current?.(); });
      void audioRecordingService.onBackground().catch(() => { if (mounted.current) setError('stop_failed'); });
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      void clear().catch(() => undefined);
    };
  }, [clear, nativeOwnerKey]);
  const invoke = (action: (captured: number) => Promise<void>) => {
    if (activeWork.current || cleanup.current || cleanupFailed.current || !flowCurrent()) return;
    const captured = generation.current;
    setPending(true);
    setError(undefined);
    const work = Promise.resolve().then(() => action(captured));
    activeWork.current = work;
    void work.catch(failure => {
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : 'recording_failed';
      if (['cleanup_failed', 'release_failed', 'storage_failed'].includes(code)) {
        cleanupFailed.current = true;
        cleanupFailure.current?.();
      }
      if (mounted.current && captured === generation.current) {
        setError(code);
      }
    }).finally(() => {
      if (activeWork.current === work) activeWork.current = null;
      if (mounted.current) { setPending(false); setPreparing(false); }
    });
  };
  const check = (captured: number) => {
    if (captured !== generation.current || !flowCurrent()) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
  };
  const getPrepared = async (recording: RecordedAudio, captured: number): Promise<PreparedAudio> => {
    check(captured);
    if (prepared.current) return prepared.current;
    setPreparing(true);
    const abort = new AbortController();
    controller.current = abort;
    const result = await prepareManagedAudio({ sourceUri: recording.uri, purpose, signal: abort.signal,
      assertCurrent: () => check(captured) });
    try { check(captured); } catch (failure) { await discardPreparedAudio(result); throw failure; }
    prepared.current = result;
    setPreparing(false);
    return result;
  };
  const startRecording = async (captured: number) => {
    check(captured);
    await audioSamplePreviewService.stop();
    check(captured);
    previewRequested.current = false;
    await audioRecordingService.start({ ownerKey: nativeOwnerKey, purpose, isCurrent: () => captured === generation.current && flowCurrent() });
  };
  const stopRecording = () => {
    if (activeWork.current) {
      ++generation.current;
      controller.current?.abort();
      void audioRecordingService.stop().catch(() => { if (mounted.current) setError('stop_failed'); });
      return;
    }
    invoke(async captured => {
      const result = await audioRecordingService.stop();
      check(captured);
      if (result) await getPrepared(result, captured);
    });
  };
  const close = () => {
    if (mounted.current) setPending(true);
    void clear().then(onClose, () => { cleanupFailure.current?.(); onClose(); });
  };
  const ready = phase === 'ready' && Boolean(source);
  const captureActive = ['requesting-permission', 'preparing', 'recording', 'starting'].includes(phase);
  const finalizing = phase === 'finalizing';
  const previewActive = previewRequested.current && ['playing', 'starting'].includes(preview.phase);
  const displayedError = error ?? (ownsRecording ? recorder.errorCode : undefined);
  const maxSeconds = purpose === 'chat' ? 30 : 8;
  const retake = () => {
    if (!ready || activeWork.current || cleanup.current || cleanupFailed.current || !flowCurrent()) return;
    ++generation.current;
    controller.current?.abort();
    invoke(async captured => {
      check(captured);
      // Deleting either file is unsafe until its player/native reader has drained.
      try { await audioSamplePreviewService.stop(nativeOwnerKey); }
      catch { throw Object.assign(new Error('cleanup_failed'), { code: 'cleanup_failed' }); }
      check(captured);
      if (prepared.current) {
        try { await discardPreparedAudio(prepared.current); prepared.current = null; }
        catch { throw Object.assign(new Error('cleanup_failed'), { code: 'cleanup_failed' }); }
      }
      check(captured);
      try { await audioRecordingService.cancelAndClear(nativeOwnerKey); }
      catch { throw Object.assign(new Error('cleanup_failed'), { code: 'cleanup_failed' }); }
      check(captured);
      await startRecording(captured);
    });
  };

  return <Modal visible transparent animationType="fade" onRequestClose={close}>
    <ScreenModalOverlay>
      <Pressable className="flex-1" accessibilityLabel={t('audioRecording.cancel')} onPress={close} />
      <ScreenSheet testID="audio-recording-sheet" style={{ maxHeight: height * 0.85 }}>
        <ScrollView style={{ maxHeight: height * 0.72 }} keyboardShouldPersistTaps="handled">
          <Box className="gap-4">
            <Box className="flex-row items-center justify-between gap-3">
              <Box className="min-w-0 flex-1 gap-1">
                <Text className="text-lg font-semibold">{t(purpose === 'chat' ? 'audioRecording.title' : 'audioRecording.referenceTitle')}</Text>
                <Text colorRole="secondary" className="text-sm">{t(purpose === 'chat' ? 'audioRecording.chatHint' : 'audioRecording.referenceHint')}</Text>
              </Box>
              <ScreenIconButton testID="audio-record-discard" iconName="close" className="h-11 w-11"
                accessibilityLabel={t('audioRecording.cancel')} accessibilityHint={t('audioRecording.cancelHint')} onPress={close} />
            </Box>
            <ScreenCard className="items-center gap-3 py-6">
              <Box className={phase === 'recording'
                ? 'h-16 w-16 items-center justify-center rounded-full bg-error-500/10'
                : 'h-16 w-16 items-center justify-center rounded-full bg-primary-500/10'}>
                <MaterialSymbols name={ready ? 'check' : 'mic'} size="lg" colorRole={phase === 'recording' ? 'danger' : 'accent'} />
              </Box>
              <Text testID="audio-recording-timer" className="text-4xl font-semibold">
                {recordingTime(ownsRecording ? recorder.durationMillis : 0)}
              </Text>
              <Text colorRole="secondary" className="text-xs">{t('audioRecording.limit', { seconds: maxSeconds })}</Text>
              <Text testID="audio-recording-phase" accessibilityLiveRegion="polite"
                colorRole={phase === 'recording' ? 'danger' : 'secondary'} className="text-sm font-semibold">
                {t('audioRecording.phases.' + (preparing ? 'preparing_audio' : phase))}
              </Text>
            </ScreenCard>
            {recorder.interrupted && ownsRecording ? <Text colorRole="warning">{t('audioRecording.interrupted')}</Text> : null}
            {displayedError ? <Text testID="audio-recording-error" colorRole="danger" accessibilityLiveRegion="polite">
              {t('audioRecording.errors.' + displayedError, { defaultValue: t('audioRecording.errors.recording_failed') })}
            </Text> : null}
            {ready && source ? <Box className="gap-3">
              <Text colorRole="secondary" className="text-sm">{t('audioRecording.readyHint')}</Text>
              <Box className="flex-row gap-3">
                {previewActive ? <Button action="secondary" testID="audio-preview-stop" className="min-h-11 flex-1"
                  onPress={() => void audioSamplePreviewService.stop(nativeOwnerKey).catch(() => {
                    cleanupFailed.current = true; if (mounted.current) setError('cleanup_failed'); cleanupFailure.current?.();
                  })}><ButtonText>{t('audioRecording.stopPreview')}</ButtonText></Button>
                  : <Button action="secondary" testID="audio-record-preview" className="min-h-11 flex-1" disabled={pending || cleanupFailed.current}
                    onPress={() => invoke(async captured => {
                      const audio = await getPrepared(source, captured);
                      check(captured);
                      previewRequested.current = true;
                      await audioSamplePreviewService.play({ ...audio, ownerKey: nativeOwnerKey, isCurrent: () => captured === generation.current && flowCurrent() });
                    })}><ButtonText>{t('audioRecording.preview')}</ButtonText></Button>}
                <Button action="secondary" testID="audio-record-retake" className="min-h-11 flex-1" disabled={pending || cleanupFailed.current} onPress={retake}>
                  <ButtonText>{t('audioRecording.retake')}</ButtonText>
                </Button>
              </Box>
              <Button testID="audio-record-attach" className="min-h-12" disabled={pending || cleanupFailed.current}
                onPress={() => invoke(async captured => {
                  await audioSamplePreviewService.stop(nativeOwnerKey);
                  const audio = await getPrepared(source, captured);
                  check(captured);
                  await onAttach(audio, source, { assertCurrent: () => check(captured) });
                  await discardPreparedAudio(audio);
                  prepared.current = null;
                  await audioRecordingService.cancelAndClear(nativeOwnerKey);
                  onClose();
                })}><ButtonText>{t(purpose === 'chat' ? 'audioRecording.attach' : 'audioRecording.useSample')}</ButtonText></Button>
            </Box> : captureActive ? <Button testID="audio-record-stop" className="min-h-12" onPress={stopRecording}>
              <ButtonText>{t('audioRecording.stop')}</ButtonText>
            </Button> : finalizing ? <Button testID="audio-record-finalizing" className="min-h-12" disabled>
              <ButtonText>{t('audioRecording.phases.finalizing')}</ButtonText>
            </Button> : <Button testID="audio-record" className="min-h-12" disabled={pending || cleanupFailed.current}
              onPress={() => invoke(startRecording)}><ButtonText>{t('audioRecording.record')}</ButtonText></Button>}
            <Text colorRole="secondary" className="text-xs leading-4">{t('audioRecording.explicitOnly')}</Text>
          </Box>
        </ScrollView>
      </ScreenSheet>
    </ScreenModalOverlay>
  </Modal>;
}
