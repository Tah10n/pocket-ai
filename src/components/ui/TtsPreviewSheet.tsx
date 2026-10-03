import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { Text } from './text';
import { Pressable } from './pressable';
import { ScrollView } from './scroll-view';
import { Input, InputField } from './input';
import { Button, ButtonText } from './button';
import { ScreenModalOverlay, ScreenSheet } from './ScreenShell';
import { getTtsSelectionStatus, ttsService, type TtsRequest, type TtsServiceState } from '../../services/TtsService';
import { isAndroidQaGenerationEvidenceEnabled } from '../../services/AndroidQaGenerationEvidence';
import { subscribeSettings } from '../../services/SettingsStore';
import { registry } from '../../services/LocalStorageRegistry';
import { prepareSpeechText, type PreparedSpeechText } from '../../utils/ttsText';
import { TTS_LIMITS, TtsError, type TtsErrorCode } from '../../types/tts';

export interface TtsPreviewSheetProps {
  initialText: string;
  reviewReason?: PreparedSpeechText['reason'];
  source?: TtsRequest['source'];
  isPreviewCurrent: () => boolean;
  onClose: () => void;
  onOpenModels: () => void;
  onCleanupFailure: () => void;
}

/** QA-only bounded status: never serialize the full service state or speech content. */
export function getTtsQaPlaybackMarker(state: TtsServiceState): string {
  const seconds = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= TTS_LIMITS.durationSeconds;
  return JSON.stringify({
    phase: state.phase,
    ...(seconds(state.position) ? { position: state.position } : {}),
    ...(seconds(state.duration) ? { duration: state.duration } : {}),
    ...(typeof state.sampleCount === 'number' && Number.isSafeInteger(state.sampleCount)
      && state.sampleCount >= 0 && state.sampleCount <= TTS_LIMITS.pcmSamples ? { sampleCount: state.sampleCount } : {}),
    ...(typeof state.sampleRate === 'number' && Number.isSafeInteger(state.sampleRate)
      && state.sampleRate >= 8_000 && state.sampleRate <= 192_000 ? { sampleRate: state.sampleRate } : {}),
    errorCode: state.errorCode ?? null,
  });
}

export function TtsPreviewSheet({ initialText, reviewReason, source, isPreviewCurrent,
  onClose, onOpenModels, onCleanupFailure }: TtsPreviewSheetProps) {
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  const state = useSyncExternalStore(ttsService.subscribe, ttsService.getState, ttsService.getState);
  const [selection, setSelection] = useState(getTtsSelectionStatus);
  const [draft, setDraft] = useState(initialText);
  const [language, setLanguage] = useState(() => getTtsSelectionStatus().languages?.[0] ?? 'en');
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [filesChecked, setFilesChecked] = useState(false);
  const [localError, setLocalError] = useState<TtsErrorCode | 'unsafe_content'>();
  const mounted = useRef(true);
  const current = useRef(true);
  const revision = useRef(0);
  const restoreVersion = useRef(0);
  const busy = useRef(false);
  const clearDrain = useRef<Promise<void> | null>(null);
  const cleanupFailed = useRef(false);
  const selectionIdentity = useRef(JSON.stringify(selection));

  const clear = useCallback((): Promise<void> => {
    ++revision.current; // Invalidate the visible request before waiting for native drain.
    if (clearDrain.current) return clearDrain.current;
    if (mounted.current) setClearing(true);
    const work = ttsService.cancelAndClear();
    clearDrain.current = work;
    void work.then(() => {
      clearDrain.current = null;
      if (mounted.current) setClearing(false);
    }, () => {
      cleanupFailed.current = true;
      clearDrain.current = null;
      if (mounted.current) setLocalError('storage_failed');
      onCleanupFailure();
    });
    return work;
  }, [onCleanupFailure]);

  useEffect(() => {
    mounted.current = true;
    current.current = true;
    const refresh = () => {
      const next = getTtsSelectionStatus();
      const identity = JSON.stringify(next);
      if (identity === selectionIdentity.current) return;
      selectionIdentity.current = identity;
      ++restoreVersion.current;
      setSelection(next);
      setFilesChecked(false);
      setReviewed(false);
      setLanguage(previous => next.languages?.includes(previous) ? previous : next.languages?.[0] ?? 'en');
      void clear().catch(() => undefined); // clear records a persistent, fail-closed UI error.
    };
    const removeSettings = subscribeSettings(refresh);
    const removeModels = registry.subscribeModels(refresh);
    refresh();
    return () => {
      current.current = false;
      mounted.current = false;
      removeSettings();
      removeModels();
      void clear().catch(() => undefined);
    };
  }, [clear]);

  let prepared: PreparedSpeechText | undefined;
  let inputError: 'unsafe_content' | undefined;
  let reason = reviewReason;
  try {
    // Edits are literal. This exact trimmed input is also displayed below.
    prepared = prepareSpeechText(draft, { structured: true });
    const detected = prepareSpeechText(draft);
    if (detected.requiresReview) reason = detected.reason;
  } catch {
    inputError = 'unsafe_content';
  }
  const tooLong = (prepared?.text.length ?? draft.length) > TTS_LIMITS.textCharacters;
  const needsReview = Boolean(reason);
  const fatalCleanup = cleanupFailed.current || ['release_failed', 'restore_failed', 'storage_failed'].includes(state.errorCode ?? '');
  const blocked = pending || clearing || fatalCleanup;
  const error = localError ?? inputError ?? selection.errorCode ?? state.errorCode;
  const audioReady = !fatalCleanup && Boolean(state.sampleCount)
    && (state.clipAvailable || ['ready', 'playing', 'paused', 'stopped'].includes(state.phase ?? ''));
  const invoke = async (action: () => Promise<void>, fallback: TtsErrorCode = 'native_failed') => {
    if (busy.current || clearDrain.current || cleanupFailed.current) return;
    busy.current = true;
    setPending(true);
    setLocalError(undefined);
    try { await action(); }
    catch (failure) {
      if (mounted.current) setLocalError(failure instanceof TtsError ? failure.code : fallback);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const close = (next: () => void) => {
    current.current = false;
    void clear().then(next, () => { onCleanupFailure(); next(); });
  };
  const changeText = (text: string) => {
    if (text !== draft) ++restoreVersion.current;
    setDraft(text); // No maxLength: pasted input is never silently cut.
    setReviewed(false);
    setFilesChecked(false);
    setLocalError(undefined);
    void clear().catch(() => undefined);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => close(onClose)}>
      <ScreenModalOverlay>
        <Pressable className="flex-1" accessibilityLabel={t('common.close')} onPress={() => close(onClose)} />
        <ScreenSheet testID="tts-preview-sheet" style={{ maxHeight: height * 0.86 }}>
          {isAndroidQaGenerationEvidenceEnabled() ? <View accessible collapsable={false}
            testID="chat-qa-tts-playback-state" accessibilityLabel={getTtsQaPlaybackMarker(state)}
            style={{ height: 1, width: 1 }} /> : null}
          {/* Measured viewport height bounds scrolling on small displays. */}
          <ScrollView style={{ maxHeight: height * 0.72 }} keyboardShouldPersistTaps="handled">
            <Box className="gap-3">
              <Box className="flex-row items-center justify-between gap-3">
                <Text className="text-lg font-semibold">{t('tts.title')}</Text>
                <Button action="secondary" size="sm" onPress={() => close(onClose)} testID="tts-close">
                  <ButtonText>{t('common.close')}</ButtonText>
                </Button>
              </Box>
              <Text colorRole="secondary">{t('tts.experimental')}</Text>
              <Text>{selection.modelName ?? t('tts.errors.selection_missing')}</Text>
              {selection.profileId?.startsWith('bluemagpie') ? <Text colorRole="warning">{t('tts.researchOnly')}</Text> : null}
              <Text colorRole="secondary">{t('tts.noRussianClaim')}</Text>
              {selection.requiredBytes ? <Text colorRole="secondary">{t('tts.memoryEstimate', {
                gb: (selection.requiredBytes / (1024 ** 3)).toFixed(1),
              })}</Text> : null}
              <Box className="flex-row flex-wrap gap-2">
                {(selection.languages ?? []).map(value => <Button key={value} size="sm" action={language === value ? 'primary' : 'secondary'}
                  accessibilityState={{ selected: language === value }} testID={'tts-language-' + value}
                  onPress={() => {
                    if (value !== language) ++restoreVersion.current;
                    setLanguage(value);
                    setReviewed(false);
                    void clear().catch(() => undefined);
                  }}>
                  <ButtonText>{t(value === 'zh-tw' ? 'tts.mandarin' : 'tts.english')}</ButtonText>
                </Button>)}
              </Box>
              <Input><InputField testID="tts-text-input" multiline value={draft} onChangeText={changeText}
                accessibilityLabel={t('tts.editText')} placeholder={t('tts.editText')} className="min-h-28 px-3 py-3" /></Input>
              <Text colorRole={tooLong ? 'danger' : 'secondary'}>{t('tts.characters', {
                count: prepared?.text.length ?? draft.length, max: TTS_LIMITS.textCharacters,
              })}</Text>
              {tooLong ? <Text colorRole="danger">{t('tts.errors.input_too_large')}</Text> : null}
              <Text className="font-semibold">{t('tts.exactPreview')}</Text>
              <Text selectable testID="tts-exact-preview">{prepared?.text ?? ''}</Text>
              {needsReview ? <Box className="gap-2">
                <Text colorRole="warning">{t('tts.review.' + reason)}</Text>
                <Button action="secondary" size="sm" testID="tts-confirm-review" onPress={() => setReviewed(value => !value)}>
                  <ButtonText>{t(reviewed ? 'tts.reviewConfirmed' : 'tts.confirmReview')}</ButtonText>
                </Button>
              </Box> : null}
              {error ? <Text testID="tts-error" colorRole="danger" accessibilityLiveRegion="polite">{t('tts.errors.' + error)}</Text> : null}
              {state.phase ? <Text testID="tts-phase" accessibilityLiveRegion="polite">{t('tts.phases.' + state.phase)}</Text> : null}
              {filesChecked ? <Text testID="tts-files-checked" colorRole="secondary">{t('tts.filesChecked')}</Text> : null}
              <Box className="flex-row flex-wrap gap-2">
                <Button action="secondary" size="sm" testID="tts-check-files" disabled={blocked || Boolean(selection.errorCode)}
                  onPress={() => void invoke(async () => {
                    const captured = revision.current;
                    await ttsService.checkFiles();
                    if (mounted.current && captured === revision.current) setFilesChecked(true);
                  })}><ButtonText>{t('tts.checkFiles')}</ButtonText></Button>
                <Button action="secondary" size="sm" onPress={() => close(onOpenModels)}>
                  <ButtonText>{t('tts.openModels')}</ButtonText>
                </Button>
                <Button testID="tts-synthesize" disabled={blocked || Boolean(selection.errorCode) || Boolean(inputError)
                  || !prepared?.text || tooLong || (needsReview && !reviewed)}
                  onPress={() => {
                    if (!prepared || busy.current || clearDrain.current || cleanupFailed.current) return;
                    const captured = revision.current;
                    const capturedRestoreVersion = restoreVersion.current;
                    const capturedSelectionIdentity = selectionIdentity.current;
                    void invoke(() => ttsService.start({ text: prepared.text, language, source,
                      isTextCurrent: () => current.current && revision.current === captured && isPreviewCurrent(),
                      // Closing/hiding blocks playback but does not change stable text or selection.
                      isRestoreCurrent: () => restoreVersion.current === capturedRestoreVersion
                        && JSON.stringify(getTtsSelectionStatus()) === capturedSelectionIdentity,
                      playAfterSynthesis: true }));
                  }}><ButtonText>{t('tts.synthesize')}</ButtonText></Button>
              </Box>
              <Box className="flex-row flex-wrap gap-2">
                {audioReady && state.phase !== 'playing' ? <Button size="sm" action="secondary" testID="tts-play" disabled={blocked}
                  onPress={() => void invoke(() => ttsService.play(), 'playback_failed')}><ButtonText>{t('tts.play')}</ButtonText></Button> : null}
                {state.phase === 'playing' ? <Button size="sm" action="secondary" testID="tts-pause"
                  onPress={() => void invoke(() => ttsService.pause(), 'playback_failed')}><ButtonText>{t('tts.pause')}</ButtonText></Button> : null}
                {audioReady ? <Button size="sm" action="secondary" testID="tts-replay" disabled={blocked}
                  onPress={() => void invoke(() => ttsService.replay(), 'playback_failed')}><ButtonText>{t('tts.replay')}</ButtonText></Button> : null}
                {state.phase ? <Button size="sm" action="secondary" testID="tts-stop" onPress={() => {
                  void ttsService.stop().catch(() => { if (mounted.current) setLocalError('release_failed'); onCleanupFailure(); });
                }}><ButtonText>{t('tts.stop')}</ButtonText></Button> : null}
              </Box>
              {typeof state.duration === 'number' ? <Text colorRole="secondary">{t('tts.progress', {
                position: (state.position ?? 0).toFixed(1), duration: state.duration.toFixed(1),
              })}</Text> : null}
            </Box>
          </ScrollView>
        </ScreenSheet>
      </ScreenModalOverlay>
    </Modal>
  );
}
