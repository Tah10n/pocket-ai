import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '../ui/box';
import { Text } from '../ui/text';
import { Button, ButtonText } from '../ui/button';
import { Input, InputField } from '../ui/input';
import { ScreenCard } from '../ui/ScreenShell';
import type { ModelMetadata } from '../../types/models';
import { LifecycleStatus } from '../../types/models';
import { normalizeSha256Digest } from '../../utils/sha256';
import { MODEL_ROLES, getModelFileIdentity, getModelRoleEvidence } from '../../utils/modelRoles';
import { bindManagedCompanion, getManagedCompanionArtifacts, getSelectedManagedCompanions, getManagedCompanionDiskPlan } from '../../utils/modelArtifacts';
import { registry } from '../../services/LocalStorageRegistry';
import { getModelDownloadManager } from '../../services/ModelDownloadManager';
import { getSettings, subscribeSettings, type AuxiliaryModelRole } from '../../services/SettingsStore';
import { AuxiliaryModelError, checkAuxiliaryModel, selectAuxiliaryModel, resolveModelForResourceEdit } from '../../services/AuxiliaryModelService';
import { useDownloadStore } from '../../store/downloadStore';

export function ModelResourcesSection({ model }: { model: ModelMetadata }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(getSettings);
  const [message, setMessage] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [url, setUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [size, setSize] = useState('');
  const abort = useRef<AbortController | null>(null);
  const queued = useDownloadStore((state) => state.queue.find((entry) => entry.id === model.id));
  useEffect(() => subscribeSettings(setSettings), []);
  useEffect(() => () => abort.current?.abort(), []);
  const evidence = getModelRoleEvidence(model);
  const artifacts = getManagedCompanionArtifacts(queued ?? model);
  const queueBusy = queued && !['paused', 'failed'].includes(queued.lifecycleStatus);
  const companionQueued = queued && artifacts.some((artifact) => ['queued', 'downloading', 'verifying', 'paused', 'failed'].includes(artifact.installState));
  const diskPlan = getManagedCompanionDiskPlan(model);
  const selectedIds = new Set(getSelectedManagedCompanions(model).map((artifact) => artifact.id));
  const baseReady = Boolean(model.localPath) && [LifecycleStatus.DOWNLOADED, LifecycleStatus.ACTIVE].includes(model.lifecycleStatus);

  const runAction = async (action: () => unknown | Promise<unknown>) => {
    try { await action(); setMessage(undefined); }
    catch { setMessage(t('resources.actionFailed')); }
  };
  const check = async (role: AuxiliaryModelRole) => {
    const controller = new AbortController();
    abort.current = controller;
    setChecking(true);
    setMessage(t('resources.checking'));
    try {
      await checkAuxiliaryModel(role, { signal: controller.signal });
      setMessage(t('resources.checkPassed'));
    } catch (error) {
      setMessage(t(`resources.errors.${error instanceof AuxiliaryModelError ? error.code : 'native_failed'}`));
    } finally { abort.current = null; setChecking(false); }
  };
  const bind = (kind: 'tts_codec' | 'lora_adapter') => runAction(() => {
    if (!size || !Number.isFinite(Number(size)) || Number(size) <= 0) throw new Error('invalid_size');
    const latest = resolveModelForResourceEdit(model);
    registry.updateModel(bindManagedCompanion(latest, {
      kind, downloadUrl: url.trim(), ...(size ? { sizeBytes: Number(size) } : {}),
      ...(sha256.trim() ? { sha256: sha256.trim() } : {}),
    }));
    setUrl(''); setSha256(''); setSize('');
  });

  return (
    <ScreenCard testID="model-resources-section" className="gap-3">
      <Text className="text-lg font-semibold">{t('resources.title')}</Text>
      <Text colorRole="secondary">{t('resources.separation')}</Text>
      {evidence.length ? evidence.map((entry, index) => (
        <Text key={`${entry.role}-${entry.source}-${index}`}>
          {t(`resources.roles.${entry.role}`)} · {t(`resources.sources.${entry.source}`)} · {t(`resources.confidence.${entry.confidence}`)}
        </Text>
      )) : <Text>{t('resources.unknown')}</Text>}
      {(['embedding', 'reranker', 'tts'] as const).filter((role) => evidence.some((entry) => entry.role === role)).map((role) => {
        const selected = settings.auxiliaryModels?.[role]?.modelId === model.id
          && settings.auxiliaryModels[role]?.fileIdentity === getModelFileIdentity(model);
        const verified = model.roleValidation?.some((entry) => entry.role === role
          && entry.fileIdentity === getModelFileIdentity(model) && entry.runtimeVersion === '0.13.0-rc.3');
        const profileReady = baseReady && (role !== 'tts' || getSelectedManagedCompanions(model)
          .some((artifact) => artifact.kind === 'tts_codec' && artifact.installState === 'installed' && artifact.localPath));
        return <Box key={role} className="gap-2">
          <Text className="font-semibold">{t(`resources.roles.${role}`)}</Text>
          <Text>{t(selected ? 'resources.selected' : 'resources.notSelected')} · {t(baseReady ? 'resources.filesReady' : 'resources.filesMissing')} · {t(verified ? 'resources.loadVerified' : 'resources.loadUnverified')}</Text>
          <Text>{t(profileReady ? 'resources.profileReady' : 'resources.profileMissing')}</Text>
          <Box className="flex-row flex-wrap gap-2">
            <Button size="sm" action="secondary" disabled={checking || Boolean(queued)} onPress={() => void runAction(() => selectAuxiliaryModel(role, selected ? null : model))}>
              <ButtonText>{t(selected ? 'resources.unselect' : 'resources.select')}</ButtonText>
            </Button>
            <Button size="sm" disabled={!selected || !baseReady || checking || Boolean(queued)} onPress={() => void check(role)} testID={`resource-check-${role}`}>
              <ButtonText>{t('resources.checkLoad')}</ButtonText>
            </Button>
          </Box>
        </Box>;
      })}
      {checking ? <Button action="secondary" onPress={() => abort.current?.abort()}><ButtonText>{t('resources.cancelCheck')}</ButtonText></Button> : null}
      {message ? <Text accessibilityLiveRegion="polite">{message}</Text> : null}
      <Text colorRole="secondary">{t('resources.futureFunctions')}</Text>
      <Text className="font-semibold">{t('resources.companions')}</Text>
      <Text colorRole="secondary">{t('resources.companionScope')}</Text>
      <Text>{t('resources.downloadBytes', { bytes: diskPlan.selectedDownloadBytes ?? t('resources.unknownSize') })}</Text>
      {artifacts.map((artifact) => (
        <Box key={artifact.id} className="gap-2 rounded-xl border border-outline-200 p-3">
          <Text>{artifact.remoteFileName}</Text>
          <Text>{t(`resources.kinds.${artifact.kind}`)} · {t(`resources.states.${artifact.installState}`)} · {t(selectedIds.has(artifact.id) ? 'resources.selected' : 'resources.notSelected')}</Text>
          <Text>{t(artifact.integrity?.kind === 'sha256' && normalizeSha256Digest(artifact.sha256)
            && normalizeSha256Digest(artifact.integrity.sha256) === normalizeSha256Digest(artifact.sha256) ? 'resources.hashVerified' : 'resources.hashUnverified')}</Text>
          <Box className="flex-row flex-wrap gap-2">
            {!selectedIds.has(artifact.id) && artifact.kind !== 'main_model' && artifact.kind !== 'multimodal_projector' ? <Button size="sm" action="secondary" disabled={Boolean(queued) || checking} onPress={() => void runAction(() => {
              registry.updateModel(bindManagedCompanion(resolveModelForResourceEdit(model), {
                kind: artifact.kind as 'tts_codec' | 'lora_adapter' | 'speculative_draft', downloadUrl: artifact.downloadUrl,
                sizeBytes: artifact.sizeBytes, sha256: artifact.sha256,
              }));
            })}><ButtonText>{t('resources.select')}</ButtonText></Button> : null}
            <Button size="sm" disabled={!model.localPath || checking || Boolean(queueBusy) || !selectedIds.has(artifact.id)} onPress={() => void runAction(() => getModelDownloadManager().prepareCompanion(model, artifact.id))}>
              <ButtonText>{t('resources.prepareRetry')}</ButtonText>
            </Button>
            <Button size="sm" action="secondary" disabled={Boolean(queued) || checking} onPress={() => void runAction(() => getModelDownloadManager().removeCompanion(model.id, artifact.id))}>
              <ButtonText>{t('common.delete')}</ButtonText>
            </Button>
          </Box>
        </Box>
      ))}
      {companionQueued ? <Box className="flex-row gap-2">
        <Button size="sm" action="secondary" onPress={() => void runAction(() => getModelDownloadManager().pauseDownload(model.id))}><ButtonText>{t('resources.pause')}</ButtonText></Button>
        <Button size="sm" action="secondary" onPress={() => void runAction(() => getModelDownloadManager().cancelDownload(model.id))}><ButtonText>{t('models.cancel')}</ButtonText></Button>
      </Box> : null}
      <Text colorRole="secondary">{t('resources.bindDescription')}</Text>
      <Input><InputField value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('resources.url')} placeholder={t('resources.url')} /></Input>
      <Input><InputField value={size} onChangeText={setSize} keyboardType="numeric" accessibilityLabel={t('resources.size')} placeholder={t('resources.size')} /></Input>
      <Input><InputField value={sha256} onChangeText={setSha256} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('resources.sha')} placeholder={t('resources.sha')} /></Input>
      <Box className="flex-row flex-wrap gap-2">
        <Button size="sm" action="secondary" disabled={!url || !size || checking || Boolean(queued)} onPress={() => void bind('tts_codec')}><ButtonText>{t('resources.bindCodec')}</ButtonText></Button>
        <Button size="sm" action="secondary" disabled={!url || !size || checking || Boolean(queued)} onPress={() => void bind('lora_adapter')}><ButtonText>{t('resources.bindLora')}</ButtonText></Button>
      </Box>
      {settings.showAdvancedInferenceControls ? <Box className="gap-2">
        <Text>{t('resources.manualDescription')}</Text>
        <Box className="flex-row flex-wrap gap-2">{MODEL_ROLES.map((role) => <Button key={role} size="sm" action="secondary" disabled={Boolean(queued) || checking} onPress={() => void runAction(() => {
          const current = resolveModelForResourceEdit(model);
          registry.updateModel({ ...current, roleEvidence: [...(current.roleEvidence ?? []), { role, source: 'manual', confidence: 'inferred' }] });
        })}><ButtonText>{t(`resources.roles.${role}`)}</ButtonText></Button>)}</Box>
      </Box> : null}
    </ScreenCard>
  );
}
