import {
  EngineStatus,
  type EngineState,
  type ModelMetadata,
} from '../types/models';
import type {
  CapabilityConfidence,
  CapabilityEvidence,
  CapabilityState,
  EffectiveInputCapabilities,
  ModelInputCapabilitySnapshot,
  NativeInputModality,
} from '../types/modelInputCapabilities';
import type {
  HuggingFaceModelConfig,
  HuggingFaceModelSummary,
  HuggingFaceSibling,
  HuggingFaceTreeEntry,
} from '../types/huggingFace';
import type { ChatAttachmentKind, ChatAttachmentProcessingState } from '../types/attachments';
import { isProjectorFileName } from './modelProjectors';

export interface InputProcessorRegistrySnapshot {
  document: boolean;
  videoFrames: boolean;
  videoAudio: boolean;
}

type DeclaredInputCapabilityAccumulator = {
  declared: Record<NativeInputModality, CapabilityState>;
  evidence: CapabilityEvidence[];
  modalityEvidence: Record<NativeInputModality, CapabilityEvidence[]>;
};

type AttachmentCapabilityInput = {
  kind: ChatAttachmentKind;
  state?: ChatAttachmentProcessingState;
};

const NATIVE_INPUT_MODALITIES: NativeInputModality[] = ['image', 'audio', 'video'];

const UNKNOWN_DECLARED_CAPABILITIES: Record<NativeInputModality, CapabilityState> = {
  image: 'unknown',
  audio: 'unknown',
  video: 'unknown',
};

const PIPELINE_MODALITY_SIGNALS: Record<string, NativeInputModality[]> = {
  'image-text-to-text': ['image'],
  'visual-question-answering': ['image'],
  'document-question-answering': ['image'],
  'audio-text-to-text': ['audio'],
  'automatic-speech-recognition': ['audio'],
  'video-text-to-text': ['video'],
};

const SIGNAL_PATTERNS: {
  modality: NativeInputModality;
  confidence: CapabilityConfidence;
  pattern: RegExp;
}[] = [
  {
    modality: 'image',
    confidence: 'medium',
    pattern: /\b(?:vision|visual|multimodal|vlm|llava|bakllava|moondream|pixtral|qwen2(?:\.5)?-?vl|qwen2vl|qwen25vl)/u,
  },
  {
    modality: 'audio',
    confidence: 'medium',
    pattern: /\b(?:audio|speech|asr|whisper|qwen2-audio)\b/u,
  },
  {
    modality: 'video',
    confidence: 'low',
    pattern: /\bvideo\b/u,
  },
];

type CapabilityEvidenceIdentity = Pick<CapabilityEvidence, 'source' | 'value'>;

function normalizeSignal(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSignalForPatternMatching(value: string): string {
  // Hugging Face config identifiers commonly use underscores (for example
  // `gemma4_audio`). JavaScript treats `_` as a word character, so a regular
  // word boundary before `audio` would otherwise miss an explicit modality.
  return value.replace(/[_/]+/gu, '-');
}

/**
 * Classifies normalized capability evidence using the same rules as catalog
 * inference. Projector filenames are intentionally passive evidence: their
 * modality is established by the catalog/runtime context that owns them.
 */
export function getInputCapabilityEvidenceModalities(
  evidence: CapabilityEvidenceIdentity,
): NativeInputModality[] {
  const value = normalizeSignal(evidence.value);
  if (!value || evidence.source === 'projector') {
    return [];
  }

  if (evidence.source === 'pipeline_tag') {
    return [...(PIPELINE_MODALITY_SIGNALS[value] ?? [])];
  }

  const matchableValue = normalizeSignalForPatternMatching(value);
  return SIGNAL_PATTERNS.flatMap((signal) => (
    signal.pattern.test(matchableValue) ? [signal.modality] : []
  ));
}

export function inputCapabilityEvidenceSupportsModality(
  evidence: CapabilityEvidenceIdentity,
  modality: NativeInputModality,
): boolean {
  return getInputCapabilityEvidenceModalities(evidence).includes(modality);
}

function normalizeDetectedAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

function normalizeCapabilityState(value: unknown): CapabilityState | null {
  return value === 'supported' || value === 'unsupported' || value === 'unknown'
    ? value
    : null;
}

function normalizeCapabilityConfidence(value: unknown): CapabilityConfidence | null {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : null;
}

function normalizeCapabilityEvidenceSource(value: unknown): CapabilityEvidence['source'] | null {
  return value === 'pipeline_tag'
    || value === 'tag'
    || value === 'architecture'
    || value === 'config'
    || value === 'repository_tree'
    || value === 'projector'
    || value === 'runtime'
    ? value
    : null;
}

function getTreeEntryFileName(entry: HuggingFaceSibling | HuggingFaceTreeEntry): string | null {
  return normalizeSignal(entry.rfilename ?? entry.filename ?? ('path' in entry ? entry.path : undefined));
}

function addEvidence(
  accumulator: DeclaredInputCapabilityAccumulator,
  modality: NativeInputModality,
  evidence: CapabilityEvidence,
): void {
  accumulator.modalityEvidence[modality].push(evidence);
  accumulator.evidence.push(evidence);
  accumulator.declared[modality] = 'supported';
}

function addPassiveEvidence(
  accumulator: DeclaredInputCapabilityAccumulator,
  evidence: CapabilityEvidence,
): void {
  accumulator.evidence.push(evidence);
}

function addPipelineEvidence(
  accumulator: DeclaredInputCapabilityAccumulator,
  pipelineTag: string | null,
): void {
  if (!pipelineTag) {
    return;
  }

  const modalities = PIPELINE_MODALITY_SIGNALS[pipelineTag] ?? [];
  for (const modality of modalities) {
    addEvidence(accumulator, modality, {
      source: 'pipeline_tag',
      value: pipelineTag,
      confidence: 'high',
    });
  }
}

function addSignalEvidence(
  accumulator: DeclaredInputCapabilityAccumulator,
  source: CapabilityEvidence['source'],
  value: string | null,
): void {
  if (!value) {
    return;
  }

  const matchableValue = normalizeSignalForPatternMatching(value);
  for (const signal of SIGNAL_PATTERNS) {
    if (!signal.pattern.test(matchableValue)) {
      continue;
    }

    addEvidence(accumulator, signal.modality, {
      source,
      value,
      confidence: signal.confidence,
    });
  }
}

function collectConfigSignals(config: HuggingFaceModelConfig | undefined): {
  source: CapabilityEvidence['source'];
  value: string;
}[] {
  const signals: { source: CapabilityEvidence['source']; value: string }[] = [];
  const configs = [config, config?.text_config, config?.vision_config, config?.audio_config];
  for (const nestedConfig of configs) {
    const modelType = normalizeSignal(nestedConfig?.model_type);
    if (modelType) {
      signals.push({ source: 'config', value: modelType });
    }

    for (const architecture of nestedConfig?.architectures ?? []) {
      const normalized = normalizeSignal(architecture);
      if (normalized) {
        signals.push({ source: 'architecture', value: normalized });
      }
    }
  }

  return signals;
}

function isGemma4ArchitectureSignal(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const compact = value.replace(/[^a-z0-9]/gu, '');
  return compact === 'gemma4' || compact.startsWith('gemma4for');
}

function resolveGemma4AudioProfileSize(
  payload: Partial<HuggingFaceModelSummary>,
): 'e2b' | 'e4b' | '12b' | null {
  const repoNames = [payload.id, payload.modelId].flatMap((value) => {
    const normalized = normalizeSignal(value);
    return normalized ? [normalized.split('/').filter(Boolean).pop() ?? normalized] : [];
  });

  for (const repoName of repoNames) {
    const match = repoName.match(/(?:^|[-_.])(e2b|e4b|12b)(?:[-_.]|$)/u);
    if (match?.[1] === 'e2b' || match?.[1] === 'e4b' || match?.[1] === '12b') {
      return match[1];
    }
  }

  return null;
}

function hasGemma4FamilyToken(value: string): boolean {
  return /(?:^|[-_.])gemma[-_.]?4(?:[-_.]|$)/u.test(value);
}

export function isKnownGemma4AudioProfileModelId(value: unknown): boolean {
  const normalized = normalizeSignal(value);
  if (!normalized) {
    return false;
  }

  const repoName = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return hasGemma4FamilyToken(repoName)
    && resolveGemma4AudioProfileSize({ id: normalized }) !== null;
}

function hasGemma4ProfileSizeToken(value: string, size: 'e2b' | 'e4b' | '12b'): boolean {
  return new RegExp(`(?:^|[-_.])${size}(?:[-_.]|$)`, 'u').test(value);
}

function hasGemma4RepositoryArtifactProfile(
  payload: Partial<HuggingFaceModelSummary>,
  treeEntries: readonly (HuggingFaceSibling | HuggingFaceTreeEntry)[],
  size: 'e2b' | 'e4b' | '12b',
): boolean {
  const repoNames = [payload.id, payload.modelId].flatMap((value) => {
    const normalized = normalizeSignal(value);
    return normalized ? [normalized.split('/').filter(Boolean).pop() ?? normalized] : [];
  });
  if (!repoNames.some((name) => hasGemma4FamilyToken(name) && hasGemma4ProfileSizeToken(name, size))) {
    return false;
  }

  const fileNames = treeEntries.flatMap((entry) => {
    const fileName = getTreeEntryFileName(entry);
    return fileName ? [fileName] : [];
  });
  const hasMatchingModelFile = fileNames.some((fileName) => (
    !isProjectorFileName(fileName)
    && hasGemma4FamilyToken(fileName)
    && hasGemma4ProfileSizeToken(fileName, size)
  ));
  const hasProjectorFile = fileNames.some(isProjectorFileName);
  return hasMatchingModelFile && hasProjectorFile;
}

function addKnownInputProfileEvidence(
  accumulator: DeclaredInputCapabilityAccumulator,
  payload: Partial<HuggingFaceModelSummary>,
  treeEntries: readonly (HuggingFaceSibling | HuggingFaceTreeEntry)[],
): void {
  const architectureSignals = [
    payload.config?.model_type,
    ...(payload.config?.architectures ?? []),
    payload.gguf?.architecture,
  ].map(normalizeSignal);
  const hasArchitectureSignal = architectureSignals.some(isGemma4ArchitectureSignal);

  // Gemma 4 audio input is model-size-specific. E2B, E4B, and 12B expose
  // native audio input; A4B and 31B do not. Require an exact supported size
  // plus either Gemma 4 architecture metadata or matching repo, model-file,
  // and projector evidence. A display name alone is never sufficient.
  const size = resolveGemma4AudioProfileSize(payload);
  if (!size || (
    !hasArchitectureSignal
    && !hasGemma4RepositoryArtifactProfile(payload, treeEntries, size)
  )) {
    return;
  }

  addEvidence(accumulator, 'audio', {
    source: hasArchitectureSignal ? 'architecture' : 'repository_tree',
    value: `gemma4-${size}-audio-profile`,
    confidence: 'high',
  });
}

function collectCardSignals(payload: Partial<HuggingFaceModelSummary>): {
  source: CapabilityEvidence['source'];
  value: string;
}[] {
  const signals: { source: CapabilityEvidence['source']; value: string }[] = [];
  const modelType = normalizeSignal(payload.cardData?.model_type);
  if (modelType) {
    signals.push({ source: 'config', value: modelType });
  }

  const ggufArchitecture = normalizeSignal(payload.gguf?.architecture);
  if (ggufArchitecture) {
    signals.push({ source: 'architecture', value: ggufArchitecture });
  }

  return signals;
}

export function mergeCapabilityEvidence(evidence: readonly CapabilityEvidence[]): CapabilityEvidence[] {
  const seen = new Set<string>();

  return evidence.flatMap((entry) => {
    const source = normalizeCapabilityEvidenceSource(entry.source);
    const value = normalizeSignal(entry.value);
    const confidence = normalizeCapabilityConfidence(entry.confidence);
    if (!source || !value || !confidence) {
      return [];
    }

    const key = `${source}\u0000${value}\u0000${confidence}`;
    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [{ source, value, confidence }];
  });
}

function mergeCapabilityState(left: CapabilityState, right: CapabilityState): CapabilityState {
  if (left === 'supported' || right === 'supported') {
    return 'supported';
  }

  if (left === 'unsupported' || right === 'unsupported') {
    return 'unsupported';
  }

  return 'unknown';
}

export function mergeInputCapabilitySnapshots(
  ...snapshots: (ModelInputCapabilitySnapshot | undefined)[]
): ModelInputCapabilitySnapshot | undefined {
  const validSnapshots = snapshots.filter((snapshot): snapshot is ModelInputCapabilitySnapshot => (
    snapshot !== undefined
  ));
  if (validSnapshots.length === 0) {
    return undefined;
  }

  return {
    detectedAt: Math.max(...validSnapshots.map((snapshot) => normalizeDetectedAt(snapshot.detectedAt))),
    declared: NATIVE_INPUT_MODALITIES.reduce<Record<NativeInputModality, CapabilityState>>((acc, modality) => {
      acc[modality] = validSnapshots.reduce<CapabilityState>(
        (state, snapshot) => mergeCapabilityState(state, snapshot.declared[modality]),
        'unknown',
      );
      return acc;
    }, { ...UNKNOWN_DECLARED_CAPABILITIES }),
    evidence: mergeCapabilityEvidence(validSnapshots.flatMap((snapshot) => snapshot.evidence)),
  };
}

export function inferDeclaredInputCapabilities(
  payload: Partial<HuggingFaceModelSummary> | null | undefined,
  treeEntries: readonly (HuggingFaceSibling | HuggingFaceTreeEntry)[] = [],
  options: { detectedAt?: number } = {},
): ModelInputCapabilitySnapshot {
  const accumulator: DeclaredInputCapabilityAccumulator = {
    declared: { ...UNKNOWN_DECLARED_CAPABILITIES },
    evidence: [],
    modalityEvidence: {
      image: [],
      audio: [],
      video: [],
    },
  };

  addPipelineEvidence(accumulator, normalizeSignal(payload?.pipeline_tag));

  for (const tag of payload?.tags ?? []) {
    addSignalEvidence(accumulator, 'tag', normalizeSignal(tag));
  }

  for (const signal of [
    ...collectConfigSignals(payload?.config),
    ...collectCardSignals(payload ?? {}),
  ]) {
    addSignalEvidence(accumulator, signal.source, signal.value);
  }

  addKnownInputProfileEvidence(accumulator, payload ?? {}, treeEntries);

  for (const entry of treeEntries) {
    const fileName = getTreeEntryFileName(entry);
    if (!fileName || !isProjectorFileName(fileName)) {
      continue;
    }

    addPassiveEvidence(accumulator, {
      source: 'projector',
      value: fileName,
      confidence: 'medium',
    });
  }

  return {
    detectedAt: options.detectedAt ?? Date.now(),
    declared: { ...accumulator.declared },
    evidence: mergeCapabilityEvidence(accumulator.evidence),
  };
}

export function normalizePersistedInputCapabilitySnapshot(value: unknown): ModelInputCapabilitySnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const declaredRecord = record.declared && typeof record.declared === 'object'
    ? record.declared as Record<string, unknown>
    : {};
  const declared = NATIVE_INPUT_MODALITIES.reduce<Record<NativeInputModality, CapabilityState>>((acc, modality) => {
    acc[modality] = normalizeCapabilityState(declaredRecord[modality]) ?? 'unknown';
    return acc;
  }, { ...UNKNOWN_DECLARED_CAPABILITIES });
  const evidence = Array.isArray(record.evidence)
    ? mergeCapabilityEvidence(record.evidence as CapabilityEvidence[])
    : [];

  return {
    detectedAt: normalizeDetectedAt(record.detectedAt),
    declared,
    evidence,
  };
}

function isEngineReadyForModel(engineState: EngineState | undefined, model: Pick<ModelMetadata, 'id' | 'lifecycleStatus'>): boolean {
  if (engineState) {
    return engineState.status === EngineStatus.READY && engineState.activeModelId === model.id;
  }

  return false;
}

function hasReadyRuntimeSupport(
  model: Pick<ModelMetadata, 'id' | 'multimodalReadiness'>,
  modality: 'vision' | 'audio',
): boolean {
  return model.multimodalReadiness?.status === 'ready'
    && model.multimodalReadiness.modelId === model.id
    && model.multimodalReadiness.support.includes(modality);
}

export function resolveEffectiveInputCapabilities({
  model,
  engineState,
  processorRegistry,
}: {
  model?: Pick<ModelMetadata, 'id' | 'lifecycleStatus' | 'multimodalReadiness'> | null;
  engineState?: EngineState;
  processorRegistry?: Partial<InputProcessorRegistrySnapshot>;
}): EffectiveInputCapabilities {
  const text = model ? isEngineReadyForModel(engineState, model) : false;
  const image = text && model ? hasReadyRuntimeSupport(model, 'vision') : false;
  const audio = text && model ? hasReadyRuntimeSupport(model, 'audio') : false;
  const document = text && processorRegistry?.document === true;
  const videoFrames = false;
  const videoAudio = false;
  const reasons: EffectiveInputCapabilities['reasons'] = {};

  if (!image) {
    reasons.image = !text ? 'model_not_ready' : 'runtime_vision_unavailable';
  }
  if (!audio) {
    reasons.audio = !text ? 'model_not_ready' : 'runtime_audio_unavailable';
  }
  if (!document) {
    reasons.document = !text ? 'model_not_ready' : 'document_processor_unavailable';
  }
  if (!videoFrames) {
    reasons.videoFrames = 'video_processing_disabled';
  }
  if (!videoAudio) {
    reasons.videoAudio = 'video_processing_disabled';
  }

  return {
    text,
    image,
    audio,
    document,
    videoFrames,
    videoAudio,
    directVideo: false,
    reasons,
  };
}

export function getUnsupportedAttachmentReason(
  capabilities: EffectiveInputCapabilities,
  attachment: AttachmentCapabilityInput,
): string | null {
  if (attachment.state !== undefined && attachment.state !== 'ready') {
    return 'attachment_not_ready';
  }

  switch (attachment.kind) {
    case 'image':
      return capabilities.image ? null : capabilities.reasons.image ?? 'runtime_vision_unavailable';
    case 'audio':
      return capabilities.audio ? null : capabilities.reasons.audio ?? 'runtime_audio_unavailable';
    case 'document':
      return capabilities.document ? null : capabilities.reasons.document ?? 'document_processor_unavailable';
    case 'video':
      return capabilities.videoFrames ? null : capabilities.reasons.videoFrames ?? 'runtime_vision_unavailable';
    default:
      return 'attachment_unsupported_type';
  }
}

export function canSendAttachments(
  capabilities: EffectiveInputCapabilities,
  attachments: readonly AttachmentCapabilityInput[],
): { ok: true } | {
  ok: false;
  unsupported: (AttachmentCapabilityInput & { reason: string })[];
} {
  const unsupported = attachments.flatMap((attachment) => {
    const reason = getUnsupportedAttachmentReason(capabilities, attachment);
    return reason ? [{ ...attachment, reason }] : [];
  });

  return unsupported.length === 0 ? { ok: true } : { ok: false, unsupported };
}
