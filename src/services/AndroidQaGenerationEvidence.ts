import type { LlmChatMessage } from '../types/chat';
import type { ChatAttachmentKind } from '../types/attachments';

export type AndroidQaGenerationGatePhase =
  | 'before-first-output'
  | 'after-first-durable-output';

export type AndroidQaPreparedAttachmentEvidence = {
  readonly id: string;
  readonly kind: ChatAttachmentKind;
};

export type AndroidQaPreparedGenerationEvidence = {
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly attachments: readonly AndroidQaPreparedAttachmentEvidence[];
};

export type AndroidQaGenerationEvidenceSnapshot = {
  readonly enabled: boolean;
  readonly armedGate: AndroidQaGenerationGatePhase | null;
  readonly activeGate: {
    readonly phase: AndroidQaGenerationGatePhase;
    readonly operationId: string;
  } | null;
  readonly preparedGeneration: AndroidQaPreparedGenerationEvidence | null;
};

const enabled = process.env.EXPO_PUBLIC_ANDROID_QA === '1' || process.env.NODE_ENV === 'test';
const listeners = new Set<() => void>();
const gateReleaseWaiters = new Map<string, Set<() => void>>();

let snapshot: AndroidQaGenerationEvidenceSnapshot = {
  enabled,
  armedGate: null,
  activeGate: null,
  preparedGeneration: null,
};

function emit(next: AndroidQaGenerationEvidenceSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function releaseGateWaiters(operationId: string): void {
  const waiters = gateReleaseWaiters.get(operationId);
  gateReleaseWaiters.delete(operationId);
  waiters?.forEach((resolve) => resolve());
}

function resolveAttachmentKind(
  attachment: NonNullable<LlmChatMessage['attachments']>[number],
): ChatAttachmentKind {
  return 'kind' in attachment ? attachment.kind : 'image';
}

export function buildAndroidQaPreparedGenerationEvidence({
  userMessageId,
  assistantMessageId,
  preparedMessages,
}: {
  userMessageId: string | null;
  assistantMessageId: string;
  preparedMessages: readonly LlmChatMessage[];
}): AndroidQaPreparedGenerationEvidence | null {
  if (!userMessageId) {
    return null;
  }

  const latestUserMessage = [...preparedMessages].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) {
    return null;
  }

  const attachmentsByIdentity = new Map<string, AndroidQaPreparedAttachmentEvidence>();
  for (const attachment of latestUserMessage.attachments ?? []) {
    if (typeof attachment.id !== 'string' || attachment.id.length === 0) {
      continue;
    }
    const kind = resolveAttachmentKind(attachment);
    attachmentsByIdentity.set(`${kind}\u0000${attachment.id}`, {
      id: attachment.id,
      kind,
    });
  }

  return {
    userMessageId,
    assistantMessageId,
    attachments: [...attachmentsByIdentity.values()].sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
    )),
  };
}

export function subscribeAndroidQaGenerationEvidence(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAndroidQaGenerationEvidenceSnapshot(): AndroidQaGenerationEvidenceSnapshot {
  return snapshot;
}

export function isAndroidQaGenerationEvidenceEnabled(): boolean {
  return enabled;
}

export function isAndroidQaGenerationGateArmed(
  phase: AndroidQaGenerationGatePhase,
): boolean {
  return snapshot.enabled && snapshot.armedGate === phase && snapshot.activeGate === null;
}

export function armAndroidQaGenerationGate(phase: AndroidQaGenerationGatePhase): boolean {
  if (!snapshot.enabled || snapshot.activeGate) {
    return false;
  }
  emit({
    ...snapshot,
    armedGate: phase,
  });
  return true;
}

export function beginAndroidQaGeneration(operationId: string): void {
  if (!snapshot.enabled) {
    return;
  }
  if (snapshot.activeGate) {
    releaseGateWaiters(snapshot.activeGate.operationId);
  }
  emit({
    ...snapshot,
    activeGate: null,
    preparedGeneration: null,
  });
  releaseGateWaiters(operationId);
}

function activateArmedGate(
  phase: AndroidQaGenerationGatePhase,
  operationId: string,
): boolean {
  if (!snapshot.enabled) {
    return false;
  }
  if (snapshot.activeGate?.operationId === operationId) {
    return snapshot.activeGate.phase === phase;
  }
  if (snapshot.armedGate !== phase) {
    return false;
  }
  emit({
    ...snapshot,
    armedGate: null,
    activeGate: { phase, operationId },
  });
  return true;
}

export function shouldHoldAndroidQaGenerationBeforeFirstOutput(operationId: string): boolean {
  return activateArmedGate('before-first-output', operationId)
    || isAndroidQaGenerationHeld(operationId);
}

export function activateAndroidQaGenerationAfterFirstDurableOutput(operationId: string): boolean {
  return activateArmedGate('after-first-durable-output', operationId);
}

export function isAndroidQaGenerationHeld(operationId: string): boolean {
  return snapshot.activeGate?.operationId === operationId;
}

export function waitForAndroidQaGenerationGateRelease(operationId: string): Promise<void> {
  if (!isAndroidQaGenerationHeld(operationId)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const waiters = gateReleaseWaiters.get(operationId) ?? new Set<() => void>();
    waiters.add(resolve);
    gateReleaseWaiters.set(operationId, waiters);
  });
}

export function releaseAndroidQaGenerationGate(operationId: string): void {
  if (snapshot.activeGate?.operationId === operationId) {
    emit({
      ...snapshot,
      activeGate: null,
    });
  }
  releaseGateWaiters(operationId);
}

export function recordAndroidQaPreparedGenerationEvidence(
  evidence: AndroidQaPreparedGenerationEvidence | null,
): void {
  if (!snapshot.enabled) {
    return;
  }
  emit({
    ...snapshot,
    preparedGeneration: evidence,
  });
}

export function resetAndroidQaGenerationEvidenceForTests(): void {
  [...gateReleaseWaiters.keys()].forEach(releaseGateWaiters);
  emit({
    enabled,
    armedGate: null,
    activeGate: null,
    preparedGeneration: null,
  });
}
