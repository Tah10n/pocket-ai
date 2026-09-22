import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '../ui/box';
import { Text } from '../ui/text';
import { Button, ButtonText } from '../ui/button';
import { ScreenInlineInput } from '../ui/ScreenShell';
import type { ModelMetadata } from '../../types/models';
import { EngineStatus } from '../../types/models';
import { getCompanionBindingIdentity, getManagedCompanionArtifacts } from '../../utils/modelArtifacts';
import { applyModelLoraAdapters } from '../../services/LoraConfigurationService';
import { llmEngineService } from '../../services/LLMEngineService';
import { getModelLoadParametersForModel } from '../../services/SettingsStore';
import { AppError } from '../../services/AppError';
import { useChatStore } from '../../store/chatStore';
import { hasActiveChatGenerationWork } from '../../services/ChatGenerationService';

export function ModelLoraControls({ model, disabled = false, onBusyChange }: {
  model: ModelMetadata; disabled?: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState(() => llmEngineService.getState());
  const [selection, setSelection] = useState(() => (getModelLoadParametersForModel(model.id).loraAdapters ?? []).map(adapter => adapter.artifactId));
  const [scales, setScales] = useState<Record<string, string>>(() => Object.fromEntries(
    (getModelLoadParametersForModel(model.id).loraAdapters ?? []).map(adapter => [adapter.artifactId, String(adapter.scale)])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // A chat switch must update admission even when the selected base model is unchanged.
  const activeThreadId = useChatStore(state => state.activeThreadId);
  useEffect(() => llmEngineService.subscribe(next => setEngine({ ...next })), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abort.current?.abort(); }; }, []);
  useEffect(() => { abort.current?.abort(); }, [activeThreadId]);
  const artifacts = getManagedCompanionArtifacts(model).filter(artifact => artifact.kind === 'lora_adapter');
  const identity = getCompanionBindingIdentity(model);
  const ready = (id: string) => artifacts.some(artifact => artifact.id === id && artifact.installState === 'installed'
    && artifact.boundToModelIdentity === identity && Boolean(artifact.localPath));
  const recovery = engine.diagnostics?.contextRecoveryStatus;
  const stateConfirmed = !busy && engine.status === EngineStatus.READY && engine.activeModelId === model.id
    && !engine.auxiliaryOperation && !engine.auxiliaryRestoreError && (!recovery || recovery === 'idle');
  const effectiveProfile = stateConfirmed ? llmEngineService.getEffectiveLoadParameters() : null;
  const applied = effectiveProfile ? effectiveProfile.loraAdapters ?? [] : null;
  const canOperate = stateConfirmed && !disabled && !busy && !hasActiveChatGenerationWork()
    && !llmEngineService.hasActiveCompletion() && !llmEngineService.hasActiveContextOperation();
  const validScale = (id: string) => {
    const text = scales[id] ?? '1';
    const value = Number(text);
    return text.trim().length > 0 && Number.isFinite(value) && value >= -16 && value <= 16;
  };
  const validSelection = selection.length <= 8 && selection.every(id => ready(id) && validScale(id));
  const apply = async (remove: boolean) => {
    if (!canOperate || (!remove && !validSelection)) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true); onBusyChange(true); setMessage(t('loraControls.applying'));
    try {
      const result = await applyModelLoraAdapters(model.id, remove ? [] : selection.map(artifactId => ({
        artifactId, scale: Number(scales[artifactId] ?? '1'),
      })), controller.signal);
      if (!mounted.current) return;
      setSelection(result.map(adapter => adapter.artifactId));
      setScales(Object.fromEntries(result.map(adapter => [adapter.artifactId, String(adapter.scale)])));
      setEngine({ ...llmEngineService.getState() });
      setMessage(t('loraControls.applied'));
    } catch (error) {
      if (mounted.current) {
        const code = error instanceof AppError && error.code === 'engine_busy' ? 'busy'
          : error instanceof AppError && error.code === 'model_memory_insufficient' ? 'memory' : 'failed';
        setMessage(t(`loraControls.${code}`));
        setEngine({ ...llmEngineService.getState() });
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      if (mounted.current) setBusy(false);
      onBusyChange(false);
    }
  };
  return <Box className="gap-3" testID="model-lora-controls">
    <Text className="font-semibold">{t('loraControls.title')}</Text>
    <Text colorRole="secondary" className="text-sm">{t('loraControls.scope')}</Text>
    {artifacts.length === 0 ? <Text colorRole="secondary">{t('loraControls.noAdapters')}</Text> : null}
    {artifacts.map(artifact => {
      const selected = selection.includes(artifact.id);
      return <Box key={artifact.id} className="gap-2 rounded-xl border border-outline-200 p-3">
        <Text>{artifact.remoteFileName}</Text>
        <Text colorRole="secondary" className="text-xs">{t(ready(artifact.id) ? 'loraControls.prepared' : 'loraControls.prepareFirst')}</Text>
        <Button size="sm" action={selected ? 'primary' : 'secondary'} testID={`lora-select-${artifact.id}`}
          accessibilityRole="checkbox" accessibilityLabel={t('loraControls.selectAdapter', { name: artifact.remoteFileName })}
          accessibilityState={{ checked: selected, disabled: disabled || busy || (!selected && (!ready(artifact.id) || selection.length >= 8)) }}
          disabled={disabled || busy || (!selected && (!ready(artifact.id) || selection.length >= 8))}
          onPress={() => setSelection(current => selected ? current.filter(id => id !== artifact.id) : [...current, artifact.id])}>
          <ButtonText>{t(selected ? 'loraControls.selected' : 'loraControls.select')}</ButtonText>
        </Button>
        {selected ? <Box className="gap-1">
          <Text className="text-xs">{t('loraControls.scaleHint', { order: selection.indexOf(artifact.id) + 1 })}</Text>
          <ScreenInlineInput testID={`lora-scale-${artifact.id}`} editable={!disabled && !busy} maxLength={24}
            accessibilityLabel={t('loraControls.scaleLabel', { name: artifact.remoteFileName })}
            value={scales[artifact.id] ?? '1'} autoCapitalize="none" autoCorrect={false}
            onChangeText={text => setScales(current => ({ ...current, [artifact.id]: text }))} />
          {!validScale(artifact.id) ? <Text colorRole="danger" accessibilityRole="alert" className="text-xs">{t('loraControls.invalidScale')}</Text> : null}
        </Box> : null}
      </Box>;
    })}
    <Text className="font-semibold">{t('loraControls.loadedTitle')}</Text>
    {applied === null ? <Text testID="lora-native-unconfirmed" colorRole="secondary">{t('loraControls.unconfirmed')}</Text>
      : applied.length === 0 ? <Text testID="lora-native-empty">{t('loraControls.noneApplied')}</Text>
        : applied.map((adapter, index) => <Text key={adapter.artifactId} testID={`lora-applied-${adapter.artifactId}`}>
          {t('loraControls.loadedAdapter', { order: index + 1,
            name: artifacts.find(artifact => artifact.id === adapter.artifactId)?.remoteFileName ?? t('loraControls.unknownAdapter'), scale: adapter.scale })}
        </Text>)}
    <Box className="flex-row flex-wrap gap-2">
      <Button size="sm" action="secondary" testID="lora-clear-selection" disabled={disabled || busy || selection.length === 0}
        onPress={() => setSelection([])}><ButtonText>{t('loraControls.clearSelection')}</ButtonText></Button>
      <Button size="sm" testID="lora-apply" disabled={!canOperate || !validSelection} onPress={() => void apply(false)}>
        <ButtonText>{t('loraControls.apply')}</ButtonText>
      </Button>
      <Button size="sm" action="secondary" testID="lora-remove-all" disabled={!canOperate || !applied?.length} onPress={() => void apply(true)}>
        <ButtonText>{t('loraControls.removeAll')}</ButtonText>
      </Button>
      {busy ? <Button size="sm" action="secondary" testID="lora-cancel" onPress={() => abort.current?.abort()}>
        <ButtonText>{t('loraControls.cancel')}</ButtonText>
      </Button> : null}
    </Box>
    {!canOperate && !busy ? <Text colorRole="secondary" className="text-xs">{t('loraControls.requiresLoaded')}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
  </Box>;
}
