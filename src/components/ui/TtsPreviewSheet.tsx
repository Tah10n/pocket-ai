import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, View, useWindowDimensions } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
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
import { AudioRecordingSheet } from './AudioRecordingSheet';
import { referenceVoiceStore, type TemporaryReferenceSource } from '../../services/ReferenceVoiceStore';
import { prepareManagedAudio, discardPreparedAudio, waitForAudioPreparationDrain, type PreparedAudio } from '../../services/AudioPreparationService';
import { audioSamplePreviewService } from '../../services/AudioSamplePreviewService';
import phonemizerNotices from '../../thirdParty/phonemize-notices.json';

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
  const samplePreview = useSyncExternalStore(audioSamplePreviewService.subscribe, audioSamplePreviewService.getState, audioSamplePreviewService.getState);
  const [selection, setSelection] = useState(getTtsSelectionStatus);
  const [draft, setDraft] = useState(initialText);
  const [language, setLanguage] = useState(() => getTtsSelectionStatus().languages?.[0] ?? 'en');
  const saved = useSyncExternalStore(referenceVoiceStore.subscribe, referenceVoiceStore.getState, referenceVoiceStore.getState);
  const [voiceMode, setVoiceMode] = useState<'speakerless' | 'builtin' | 'reference'>(() => getTtsSelectionStatus().voiceModes?.[0] ?? 'speakerless');
  const [builtinVoice, setBuiltinVoice] = useState(() => getTtsSelectionStatus().builtinVoices?.[0] ?? '');
  const [temporary, setTemporary] = useState<TemporaryReferenceSource>();
  const [consent, setConsent] = useState(false);
  const [voiceName, setVoiceName] = useState('');
  const [recording, setRecording] = useState(false);
  const [bake, setBake] = useState<'lazy' | 'eager'>('eager');
  const [showNotices, setShowNotices] = useState(false);
  const [referencePreviewOwner] = useState(() => 'tts-reference-preview:' + Date.now() + ':' + Math.random());
  const temporaryOwner = useRef<TemporaryReferenceSource | undefined>(undefined);
  const previewDerivative = useRef<PreparedAudio | undefined>(undefined);
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [sampleStopping, setSampleStopping] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [filesChecked, setFilesChecked] = useState(false);
  const [localError, setLocalError] = useState<TtsErrorCode | 'unsafe_content'>();
  const mounted = useRef(true);
  const current = useRef(true);
  const revision = useRef(0);
  const restoreVersion = useRef(0);
  const voiceRevision = useRef(0);
  const busy = useRef(false);
  const clearDrain = useRef<Promise<void> | null>(null);
  const sampleStopDrain = useRef<Promise<void> | null>(null);
  const cleanupFailed = useRef(false);
  const selectionIdentity = useRef(JSON.stringify(selection));

  const clear = useCallback((): Promise<void> => {
    ++revision.current; // Invalidate the visible request before waiting for native drain.
    if (clearDrain.current) return clearDrain.current;
    if (mounted.current) setClearing(true);
    const work = (async () => {
      await ttsService.cancelAndClear();
      await audioSamplePreviewService.stop(referencePreviewOwner);
      await sampleStopDrain.current;
      await waitForAudioPreparationDrain();
      if (previewDerivative.current) { await discardPreparedAudio(previewDerivative.current); previewDerivative.current = undefined; }
    })();
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
  }, [onCleanupFailure, referencePreviewOwner]);

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
      setVoiceMode(previous => next.voiceModes?.includes(previous) ? previous : next.voiceModes?.[0] ?? 'speakerless');
      setBuiltinVoice(previous => next.builtinVoices?.includes(previous) ? previous : next.builtinVoices?.[0] ?? '');
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
      void clear().then(async () => { await temporaryOwner.current?.release(); temporaryOwner.current = undefined; })
        .catch(() => onCleanupFailure());
    };
  }, [clear, onCleanupFailure]);
  useEffect(() => { try { referenceVoiceStore.hydrate(); } catch { setLocalError('storage_failed'); } }, []);

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
  const blocked = pending || clearing || sampleStopping || fatalCleanup;
  const error = localError ?? inputError ?? selection.errorCode ?? state.errorCode;
  const audioReady = !fatalCleanup && Boolean(state.sampleCount)
    && (state.clipAvailable || ['ready', 'playing', 'paused', 'stopped'].includes(state.phase ?? ''));
  const invoke = async (action: () => Promise<void>, fallback: TtsErrorCode = 'native_failed') => {
    if (busy.current || clearDrain.current || sampleStopDrain.current || cleanupFailed.current) return;
    busy.current = true;
    setPending(true);
    setLocalError(undefined);
    try { await action(); }
    catch (failure) {
      const uncertainCleanup = failure && typeof failure === 'object' && 'code' in failure && failure.code === 'cleanup_failed';
      if (uncertainCleanup) {
        cleanupFailed.current = true;
        onCleanupFailure();
      }
      if (mounted.current) setLocalError(uncertainCleanup ? 'storage_failed' : failure instanceof TtsError ? failure.code : fallback);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const close = (next: () => void) => {
    current.current = false;
    void clear().then(async () => { await temporaryOwner.current?.release(); temporaryOwner.current = undefined; next(); },
      () => { onCleanupFailure(); next(); }).catch(() => { onCleanupFailure(); next(); });
  };
  const assertReferenceCurrent = (captured: number) => {
    if (!current.current || !mounted.current || revision.current !== captured || !isPreviewCurrent()) throw new TtsError('cancelled');
  };
  const stopReferencePreview = () => {
    ++revision.current;
    if (sampleStopDrain.current) return;
    setSampleStopping(true);
    const work = (async () => {
      await audioSamplePreviewService.stop(referencePreviewOwner);
      await waitForAudioPreparationDrain();
      if (previewDerivative.current) { await discardPreparedAudio(previewDerivative.current); previewDerivative.current = undefined; }
    })();
    sampleStopDrain.current = work;
    void work.catch(() => {
      cleanupFailed.current = true;
      if (mounted.current) setLocalError('storage_failed');
      onCleanupFailure();
    }).finally(() => {
      if (sampleStopDrain.current === work) sampleStopDrain.current = null;
      if (mounted.current) setSampleStopping(false);
    });
  };
  const retainReference = async (preparedAudio: PreparedAudio, sourceUri: string, sourceMimeType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4',
    assertRecordingCurrent?: () => void) => {
    // The store admits one temporary owner. Drain its native consumers and release the
    // previous immutable source before making a replacement copy.
    const drain = clear();
    const captured = revision.current;
    await drain;
    const check = () => { assertReferenceCurrent(captured); assertRecordingCurrent?.(); };
    check();
    await temporaryOwner.current?.release();
    temporaryOwner.current = undefined;
    setTemporary(undefined);
    check();
    const next = await referenceVoiceStore.retainTemporarySource({ sourceUri, sourceSha256: preparedAudio.sourceSha256,
      durationMs: preparedAudio.durationMs, sourceMimeType }, { assertCurrent: check });
    try {
      check();
      temporaryOwner.current = next;
      setTemporary(next);
      setConsent(false);
      referenceVoiceStore.select(null);
      ++voiceRevision.current;
    } catch (failure) { await next.release(); throw failure; }
  };
  const selectedSavedVoice = saved.voices.find(item => item.id === saved.selectedVoiceId);
  const referenceReady = Boolean(selectedSavedVoice || (temporary?.isCurrent() && consent));
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
              {selection.profileId?.startsWith('neutts') ? <Text colorRole="warning">{t('tts.neuttsLicense')}</Text> : null}
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
              <Text className="font-semibold">{t('tts.voiceMode')}</Text>
              <Box className="flex-row flex-wrap gap-2">
                {(selection.voiceModes ?? ['speakerless']).map(mode => <Button key={mode} size="sm"
                  testID={'tts-mode-' + mode} action={voiceMode === mode ? 'primary' : 'secondary'}
                  accessibilityState={{ selected: voiceMode === mode }} disabled={clearing || fatalCleanup}
                  onPress={() => { ++voiceRevision.current; setVoiceMode(mode); void clear().catch(() => undefined); }}>
                  <ButtonText>{t('tts.modes.' + mode)}</ButtonText>
                </Button>)}
              </Box>
              {voiceMode === 'builtin' ? <Box className="gap-2">
                <Text colorRole="secondary">{t('tts.localPhonemizer')}</Text>
                <Button size="sm" action="secondary" onPress={() => setShowNotices(value => !value)}>
                  <ButtonText>{t('tts.phonemizerNotices')}</ButtonText>
                </Button>
                {showNotices ? <Text selectable>{phonemizerNotices.notices.map(item => item.component + '\n' + item.license).join('\n\n')}</Text> : null}
                <Box className="flex-row flex-wrap gap-2">{(selection.builtinVoices ?? []).map(voice => <Button key={voice}
                  size="sm" testID={'tts-builtin-' + voice} action={builtinVoice === voice ? 'primary' : 'secondary'}
                  accessibilityState={{ selected: builtinVoice === voice }} disabled={clearing || fatalCleanup}
                  onPress={() => { ++voiceRevision.current; setBuiltinVoice(voice); void clear().catch(() => undefined); }}>
                  <ButtonText>{voice}</ButtonText>
                </Button>)}</Box>
              </Box> : null}
              {voiceMode === 'reference' ? <Box className="gap-2">
                <Text colorRole="secondary">{t('tts.referenceInfo')}</Text>
                <Box className="flex-row flex-wrap gap-2">{(['eager', 'lazy'] as const).map(value => <Button key={value}
                  size="sm" action={bake === value ? 'primary' : 'secondary'} disabled={clearing || fatalCleanup}
                  testID={'tts-bake-' + value} accessibilityState={{ selected: bake === value }}
                  onPress={() => { ++voiceRevision.current; setBake(value); void clear().catch(() => undefined); }}>
                  <ButtonText>{t('tts.bake.' + value)}</ButtonText>
                </Button>)}</Box>
                <Box className="flex-row flex-wrap gap-2">
                  <Button size="sm" action="secondary" disabled={blocked} testID="tts-reference-record"
                    onPress={() => {
                      const drain = clear();
                      const captured = revision.current;
                      void drain.then(() => { assertReferenceCurrent(captured); setRecording(true); }).catch(() => undefined);
                    }}>
                    <ButtonText>{t('tts.recordReference')}</ButtonText>
                  </Button>
                  <Button size="sm" action="secondary" disabled={blocked} testID="tts-reference-import"
                    onPress={() => void invoke(async () => {
                      const drain = clear();
                      const captured = revision.current;
                      await drain;
                      assertReferenceCurrent(captured);
                      const picked = await DocumentPicker.getDocumentAsync({ type: ['audio/wav', 'audio/mpeg', 'audio/mp4'],
                        copyToCacheDirectory: true, multiple: false });
                      if (picked.canceled) return;
                      const asset = picked.assets[0];
                      let preparedAudio: PreparedAudio | undefined;
                      try {
                        assertReferenceCurrent(captured);
                        preparedAudio = await prepareManagedAudio({ sourceUri: asset.uri, purpose: 'reference', sampleRate: 24000,
                          assertCurrent: () => assertReferenceCurrent(captured) });
                        const mime = asset.mimeType === 'audio/wav' || asset.mimeType === 'audio/x-wav' ? 'audio/wav'
                          : asset.mimeType === 'audio/mpeg' ? 'audio/mpeg' : 'audio/mp4';
                        await retainReference(preparedAudio, asset.uri, mime);
                      } finally {
                        if (preparedAudio) await discardPreparedAudio(preparedAudio);
                        if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) {
                          await FileSystem.deleteAsync(asset.uri, { idempotent: true });
                          if ((await FileSystem.getInfoAsync(asset.uri)).exists) throw new TtsError('storage_failed');
                        }
                      }
                    }, 'reference_invalid')}><ButtonText>{t('tts.importReference')}</ButtonText></Button>
                </Box>
                {temporary ? <Box className="gap-2">
                  <Text>{t('tts.temporaryReference', { seconds: (temporary.durationMs / 1000).toFixed(1) })}</Text>
                  <Button size="sm" action="secondary" disabled={blocked} testID="tts-reference-preview"
                    onPress={() => void invoke(async () => {
                      const captured = revision.current;
                      await ttsService.stop();
                      assertReferenceCurrent(captured);
                      await audioSamplePreviewService.stop();
                      assertReferenceCurrent(captured);
                      if (previewDerivative.current) { await discardPreparedAudio(previewDerivative.current); previewDerivative.current = undefined; }
                      const derivative = await prepareManagedAudio({ sourceUri: temporary.uri, purpose: 'reference', sampleRate: 24000,
                        assertCurrent: () => assertReferenceCurrent(captured) });
                      try {
                        assertReferenceCurrent(captured);
                        if (!temporary.isCurrent()) throw new TtsError('selection_changed');
                        previewDerivative.current = derivative;
                        await audioSamplePreviewService.play({ uri: derivative.uri, sampleRate: derivative.sampleRate,
                          sampleCount: derivative.sampleCount, ownerKey: referencePreviewOwner,
                          isCurrent: () => current.current && revision.current === captured && temporary.isCurrent() });
                      } catch (failure) {
                        if (previewDerivative.current === derivative) {
                          await audioSamplePreviewService.stop(referencePreviewOwner); previewDerivative.current = undefined;
                        }
                        await discardPreparedAudio(derivative); throw failure;
                      }
                    }, 'playback_failed')}><ButtonText>{t('tts.previewReference')}</ButtonText></Button>
                  {['starting', 'playing', 'paused'].includes(samplePreview.phase) ? <Button size="sm" action="secondary"
                    testID="tts-reference-preview-stop" disabled={sampleStopping || clearing}
                    onPress={stopReferencePreview}><ButtonText>{t('tts.stop')}</ButtonText></Button> : null}
                  <Button size="sm" action="secondary" disabled={blocked} testID="tts-reference-remove"
                    onPress={() => void invoke(async () => {
                      ++voiceRevision.current; await clear(); await temporaryOwner.current?.release();
                      temporaryOwner.current = undefined; setTemporary(undefined); setConsent(false);
                    }, 'storage_failed')}><ButtonText>{t('tts.removeReference')}</ButtonText></Button>
                  <Button size="sm" action="secondary" disabled={clearing || fatalCleanup} testID="tts-reference-consent"
                    accessibilityState={{ checked: consent }} onPress={() => { ++voiceRevision.current; setConsent(value => !value); void clear().catch(() => undefined); }}>
                    <ButtonText>{t(consent ? 'tts.consentConfirmed' : 'tts.referenceConsent')}</ButtonText>
                  </Button>
                  <Input><InputField value={voiceName} onChangeText={setVoiceName} maxLength={60}
                    testID="tts-reference-name" placeholder={t('tts.voiceName')} accessibilityLabel={t('tts.voiceName')} /></Input>
                  <Button size="sm" action="secondary" disabled={blocked || !consent || !voiceName.trim()} testID="tts-reference-save"
                    onPress={() => void invoke(async () => {
                      await clear(); const captured = revision.current;
                      const voice = await referenceVoiceStore.save({ sourceUri: temporary.uri, sourceSha256: temporary.sourceSha256,
                        durationMs: temporary.durationMs, sourceMimeType: temporary.sourceMimeType, name: voiceName,
                        consent: true, language }, { assertCurrent: () => assertReferenceCurrent(captured) });
                      assertReferenceCurrent(captured); referenceVoiceStore.select(voice.id); ++voiceRevision.current;
                    }, 'storage_failed')}><ButtonText>{t('tts.saveReference')}</ButtonText></Button>
                </Box> : null}
                {saved.voices.map(voice => <Box key={voice.id} className="flex-row flex-wrap gap-2">
                  <Button size="sm" action={saved.selectedVoiceId === voice.id ? 'primary' : 'secondary'} disabled={clearing || fatalCleanup}
                    testID={'tts-saved-' + voice.id} onPress={() => {
                      ++voiceRevision.current; referenceVoiceStore.select(voice.id); void clear().catch(() => undefined);
                    }}><ButtonText>{voice.name}</ButtonText></Button>
                  <Button size="sm" action="secondary" disabled={blocked} testID={'tts-delete-' + voice.id}
                    onPress={() => void invoke(async () => { ++voiceRevision.current; await clear(); await referenceVoiceStore.delete(voice.id); }, 'storage_failed')}>
                    <ButtonText>{t('tts.deleteReference')}</ButtonText>
                  </Button>
                </Box>)}
                {temporary && selectedSavedVoice ? <Button size="sm" action="secondary" disabled={blocked}
                  onPress={() => { ++voiceRevision.current; referenceVoiceStore.select(null); void clear().catch(() => undefined); }}>
                  <ButtonText>{t('tts.useTemporary')}</ButtonText></Button> : null}
              </Box> : null}
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
                  || !prepared?.text || tooLong || (needsReview && !reviewed)
                  || (voiceMode === 'builtin' && !builtinVoice) || (voiceMode === 'reference' && !referenceReady)}
                  onPress={() => {
                    if (!prepared || busy.current || clearDrain.current || cleanupFailed.current) return;
                    const captured = revision.current;
                    const capturedRestoreVersion = restoreVersion.current;
                    const capturedVoiceVersion = voiceRevision.current;
                    const capturedSelectionIdentity = selectionIdentity.current;
                    const capturedTemporary = voiceMode === 'reference' && !selectedSavedVoice ? temporary : undefined;
                    const voice = voiceMode === 'reference' ? { kind: 'reference' as const, bake, source: selectedSavedVoice
                      ? { kind: 'saved' as const, voiceId: selectedSavedVoice.id, sourceSha256: selectedSavedVoice.sourceSha256 }
                      : { kind: 'temporary' as const, sourceUri: temporary!.uri, sourceSha256: temporary!.sourceSha256,
                          durationMs: temporary!.durationMs, consent: true as const } }
                      : voiceMode === 'builtin' ? { kind: 'builtin' as const, voice: builtinVoice } : { kind: 'speakerless' as const };
                    void invoke(() => ttsService.start({ text: prepared.text, language, source,
                      voice, isTextCurrent: () => current.current && revision.current === captured && isPreviewCurrent()
                        && capturedTemporary?.isCurrent() !== false,
                      isVoiceCurrent: () => voiceRevision.current === capturedVoiceVersion && capturedTemporary?.isCurrent() !== false,
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
      {recording ? <AudioRecordingSheet ownerKey="tts-reference" purpose="reference"
        isCurrent={() => current.current && isPreviewCurrent()} onCleanupFailure={onCleanupFailure}
        onClose={() => setRecording(false)} onAttach={(audio, recorded, ownership) => retainReference(audio, recorded.uri, 'audio/mp4', ownership.assertCurrent)} /> : null}
    </Modal>
  );
}
