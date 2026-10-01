import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { Pressable } from './pressable';
import { ScrollView } from './scroll-view';
import { Text } from './text';
import { ProgressBar } from './ProgressBar';
import { ScreenSegmentedControl } from './ScreenShell';
import { Surface } from '@/design-system/materials/Surface';
import type { DocumentIndexCacheFailure, DocumentRetrievalIssue, DocumentRetrievalSettings } from '@/types/documentRetrieval';
import type { ActualDocumentRetrievalMode } from '@/services/DocumentRetrievalService';

export interface DocumentPreparationCardItem {
  attachmentId: string;
  displayName: string;
  status: 'not_ready' | 'stale' | 'preparing' | 'ready' | 'error' | 'cancelled';
  processed?: number;
  total?: number;
  issue?: DocumentRetrievalIssue;
  cancelling?: boolean;
}

// NativeWind's native 14 dp rem makes min-h-11 38.5 dp; min-h-14 exceeds the 44 dp touch minimum.
export function DocumentPreparationCard({ document, disabled, onPrepare, onCancel }: {
  document: DocumentPreparationCardItem;
  disabled: boolean;
  onPrepare: (attachmentId: string) => void;
  onCancel: (attachmentId: string) => void;
}) {
  const { t } = useTranslation();
  const isPreparing = document.status === 'preparing';
  const total = Number.isFinite(document.total) && document.total! > 0 ? document.total! : 0;
  const processed = Number.isFinite(document.processed) ? Math.max(0, Math.min(total, document.processed!)) : 0;
  return (
    <Surface material={{ role: 'content', variant: 'inset' }} className="gap-1 px-3 py-2"
      testID={`document-preparation-${document.attachmentId}`}>
      <Box className="flex-row items-center gap-2">
        <Box className="min-w-0 flex-1">
          <Text colorRole="primary" textRole="chip" numberOfLines={2}>{document.displayName}</Text>
          <Text colorRole={document.status === 'ready' ? 'success' : 'secondary'} textRole="caption"
            accessibilityLiveRegion="polite" testID={`document-preparation-status-${document.attachmentId}`}>
            {t(`chat.retrieval.status.${document.cancelling ? 'cancelling' : document.status}`)}
            {isPreparing && total ? ` · ${Math.floor(processed / total * 100)}%` : ''}
          </Text>
        </Box>
        {isPreparing ? (
          <Pressable className="min-h-14 justify-center px-2" accessibilityRole="button"
            accessibilityLabel={t('chat.retrieval.cancelDocument', { name: document.displayName })}
            disabled={document.cancelling} accessibilityState={{ disabled: document.cancelling === true }}
            testID={`document-preparation-cancel-${document.attachmentId}`}
            onPress={() => onCancel(document.attachmentId)}>
            <Text colorRole="accent" textRole="action">{t(document.cancelling ? 'chat.retrieval.status.cancelling' : 'common.cancel')}</Text>
          </Pressable>
        ) : document.status !== 'ready' ? (
          <Pressable className="min-h-14 justify-center px-2" accessibilityRole="button"
            accessibilityLabel={t('chat.retrieval.prepareDocument', { name: document.displayName })}
            accessibilityState={{ disabled }} disabled={disabled}
            testID={`document-preparation-start-${document.attachmentId}`}
            onPress={() => onPrepare(document.attachmentId)}>
            <Text colorRole={disabled ? 'tertiary' : 'accent'} textRole="action">{t('chat.retrieval.prepare')}</Text>
          </Pressable>
        ) : null}
      </Box>
      {isPreparing ? <ProgressBar valuePercent={total ? processed / total * 100 : 0} size="sm" tone="primary"
        testID={`document-preparation-progress-${document.attachmentId}`} /> : null}
      {document.issue ? <Text colorRole="secondary" textRole="caption">
        {t(`chat.retrieval.reasons.${document.issue}`)}
      </Text> : null}
    </Surface>
  );
}

/** Settings are explicit; mounting or expanding this view never prepares an index. */
export function ChatDocumentRetrievalControl({ settings, onChange, disabled = false,
  embeddingModelName, rerankerModelName, documents = [], onPrepare, onCancel, onExpand, actualMode, fallbackReason, cacheFailures,
}: {
  settings: DocumentRetrievalSettings;
  onChange: (settings: DocumentRetrievalSettings) => void;
  disabled?: boolean;
  embeddingModelName?: string;
  rerankerModelName?: string;
  documents?: readonly DocumentPreparationCardItem[];
  onPrepare: (attachmentId: string) => void;
  onCancel: (attachmentId: string) => void;
  onExpand?: () => void;
  actualMode?: ActualDocumentRetrievalMode;
  fallbackReason?: DocumentRetrievalIssue;
  cacheFailures?: readonly DocumentIndexCacheFailure[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const requestedMode: ActualDocumentRetrievalMode = settings.rerank ? `${settings.mode}+rerank` : settings.mode;
  const preparingDocument = documents.find(document => document.status === 'preparing');
  return (
    <Surface material={{ role: 'content', variant: 'raised' }} className="mx-3 mb-1 px-3"
      testID="chat-document-retrieval-control">
      <Pressable className="min-h-14 flex-row items-center justify-between gap-2" accessibilityRole="button"
        accessibilityLabel={t('chat.retrieval.controls')} accessibilityState={{ expanded }}
        testID="chat-retrieval-expand" onPress={() => {
          if (!expanded) onExpand?.();
          setExpanded(!expanded);
        }}>
        <Text colorRole="primary" textRole="chip" className="min-w-0 flex-1">
          {t('chat.retrieval.title')} · {t(`chat.retrieval.modes.${requestedMode}`)}
        </Text>
        <Text colorRole="accent" textRole="caption">{t(expanded ? 'chat.retrieval.hide' : 'chat.retrieval.controls')}</Text>
      </Pressable>
      {!expanded && preparingDocument ? <Box className="flex-row items-center gap-2 pb-2">
        <Text colorRole="secondary" textRole="caption" className="min-w-0 flex-1" numberOfLines={2}
          accessibilityLiveRegion="polite">{t(preparingDocument.cancelling ? 'chat.retrieval.cancellingDocument' : 'chat.retrieval.preparingDocument', { name: preparingDocument.displayName })}</Text>
        <Pressable className="min-h-14 justify-center px-2" accessibilityRole="button"
          accessibilityLabel={t('chat.retrieval.cancelDocument', { name: preparingDocument.displayName })}
          disabled={preparingDocument.cancelling} accessibilityState={{ disabled: preparingDocument.cancelling === true }}
          testID="chat-retrieval-cancel-active" onPress={() => onCancel(preparingDocument.attachmentId)}>
          <Text colorRole="accent" textRole="action">{t(preparingDocument.cancelling ? 'chat.retrieval.status.cancelling' : 'common.cancel')}</Text>
        </Pressable>
      </Box> : null}
      {actualMode ? <Text colorRole="secondary" textRole="caption" className="pb-2" testID="chat-retrieval-actual-mode">
        {t('chat.retrieval.actualMode', { mode: t(`chat.retrieval.modes.${actualMode}`) })}
        {fallbackReason ? ` · ${t('chat.retrieval.fallback', { reason: t(`chat.retrieval.reasons.${fallbackReason}`) })}` : ''}
      </Text> : null}
      {cacheFailures?.length ? <Text colorRole="secondary" textRole="caption" className="pb-2"
        accessibilityLiveRegion="polite" testID="chat-retrieval-cache-unsaved">
        {t('chat.retrieval.cacheUnsaved', { reason: t(`chat.retrieval.reasons.${cacheFailures[0].reason}`) })}
      </Text> : null}
      {expanded ? <ScrollView className="max-h-80" keyboardShouldPersistTaps="handled"
        testID="chat-retrieval-details">
        <Box className="gap-2 pb-3">
          <Text colorRole="secondary" textRole="caption">{t('chat.retrieval.description')}</Text>
          <ScreenSegmentedControl activeKey={settings.mode} disabled={disabled} density="compact" itemClassName="min-h-14"
            options={(['lexical', 'hybrid'] as const).map(mode => ({ key: mode, label: t(`chat.retrieval.modes.${mode}`),
              testID: `chat-retrieval-mode-${mode}` }))}
            onChange={mode => onChange({ ...settings, mode: mode === 'hybrid' ? 'hybrid' : 'lexical' })} />
          <Pressable className="min-h-14 justify-center" accessibilityRole="switch" disabled={disabled}
            accessibilityLabel={t('chat.retrieval.enableRerank')}
            accessibilityState={{ checked: settings.rerank, disabled }} testID="chat-retrieval-rerank"
            onPress={() => onChange({ ...settings, rerank: !settings.rerank })}>
            <Text colorRole={disabled ? 'tertiary' : 'primary'} textRole="action">
              {t('chat.retrieval.rerank')} · {t(settings.rerank ? 'chat.tools.on' : 'chat.tools.off')}
            </Text>
          </Pressable>
          <Text colorRole="secondary" textRole="caption" testID="chat-retrieval-embedding-model">
            {t('chat.retrieval.embeddingModel', { name: embeddingModelName ?? t('chat.retrieval.modelNotSelected') })}
          </Text>
          <Text colorRole="secondary" textRole="caption" testID="chat-retrieval-reranker-model">
            {t('chat.retrieval.rerankerModel', { name: rerankerModelName ?? t('chat.retrieval.modelNotSelected') })}
          </Text>
          <Text colorRole="secondary" textRole="caption">{t('chat.retrieval.preparationDescription')}</Text>
          {documents.map(document => <DocumentPreparationCard key={document.attachmentId} document={document}
            disabled={disabled || settings.mode !== 'hybrid' || !embeddingModelName}
            onPrepare={onPrepare} onCancel={onCancel} />)}
          {!documents.length ? <Text colorRole="tertiary" textRole="caption">{t('chat.retrieval.noDocuments')}</Text> : null}
        </Box>
      </ScrollView> : null}
    </Surface>
  );
}
