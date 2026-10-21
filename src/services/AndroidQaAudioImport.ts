import * as FileSystem from 'expo-file-system/legacy';
import * as RNFS from 'react-native-fs';
import { useChatStore, flushPendingChatPersistenceWrites } from '../store/chatStore';
import { readChatThreadRecord } from '../store/chatPersistence';
import { getAppStorage } from '../store/storage';
import { DEFAULT_PRESET_SNAPSHOT } from '../types/chat';
import type { ChatMediaAttachmentDraft } from '../types/attachments';
import { fileUriToNativePath } from '../utils/safeFilePath';
import { chatAttachmentStorageService, getChatAttachmentsDir, materializeMediaDraftsForMessage } from './ChatAttachmentStorageService';
import { ANDROID_QA_DOCUMENT_MODEL_ID } from './AndroidQaDocumentModelBootstrap';
import { getAppCacheRootDir } from './FileSystemSetup';
import { isAndroidQaAudioStage7Enabled } from './AndroidQaAudioStage7';

type Fixture = { name: string; sizeBytes: number; sha256: string };
type Receipt = { process: string; threadId?: string; previousThreadId: string | null; fixtures: Fixture[];
  cleanup?: { ownedUris: string[]; coldVerified: boolean } };
type Evidence = { status: 'idle' | 'running' | 'awaiting_restart' | 'passed' | 'failed'; phase: string;
  steps: string[]; fixtures: Fixture[]; uiSend: 'not_run'; inference: 'not_run' };
const names = ['over-four-MiB.wav', 'forty-seconds.wav', 'legacy-import.mp3'];
const title = 'QA audio import storage only';
const processIdentity = `${Date.now()}-${Math.random()}`;
let evidence: Evidence = { status: 'idle', phase: 'idle', steps: [], fixtures: [], uiSend: 'not_run', inference: 'not_run' };
let active = false;
let pendingCleanup: Receipt | undefined;
const listeners = new Set<() => void>();
export const getAndroidQaAudioImportEvidence = () => evidence;
export const subscribeAndroidQaAudioImport = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (patch: Partial<Evidence>) => { evidence = { ...evidence, ...patch }; listeners.forEach(listener => listener()); };
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const hash = (uri: string) => RNFS.hash(fileUriToNativePath(uri), 'sha256');
async function readSmallJson(uri: string): Promise<any> {
  const info = await FileSystem.getInfoAsync(uri);
  check(info.exists && !info.isDirectory && info.size > 0 && info.size <= 16_384, 'qa_metadata_missing');
  return JSON.parse(await FileSystem.readAsStringAsync(uri));
}
function fixturesOf(value: unknown): Fixture[] {
  check(Array.isArray(value) && value.length === names.length, 'fixture_manifest_invalid');
  return names.map(name => {
    const item = value.find(entry => entry?.name === name);
    check(item && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0 && item.sizeBytes <= 25 * 1024 * 1024
      && /^[a-f0-9]{64}$/u.test(item.sha256), 'fixture_manifest_invalid');
    if (name === names[0]) check(item.sizeBytes > 4 * 1024 * 1024, 'large_fixture_too_small');
    return { name, sizeBytes: item.sizeBytes, sha256: item.sha256 };
  });
}

async function cleanupOwned(receipt: Receipt, receiptUri: string): Promise<void> {
  const owned = receipt.cleanup?.ownedUris;
  const directory = getChatAttachmentsDir();
  check(directory && Array.isArray(owned) && owned.length <= 4 && owned.every(uri => typeof uri === 'string'
    && uri.startsWith(directory) && /^draft-[0-9]+-[a-z0-9]+\.(wav|mp3)$/u.test(uri.slice(directory.length))), 'cleanup_owner_invalid');
  const thread = receipt.threadId ? useChatStore.getState().threads[receipt.threadId] : undefined;
  check(!thread || thread.title === title && thread.messages.every(message => message.attachments?.every(item => owned.includes(item.localUri))), 'cleanup_thread_invalid');
  for (const uri of owned) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
    check(!(await FileSystem.getInfoAsync(uri)).exists, 'cleanup_failed');
  }
  if (thread && receipt.threadId) {
    useChatStore.getState().deleteThread(receipt.threadId);
    check(!useChatStore.getState().threads[receipt.threadId], 'cleanup_failed');
  }
  useChatStore.getState().setActiveThread(receipt.previousThreadId);
  flushPendingChatPersistenceWrites();
  await FileSystem.deleteAsync(receiptUri, { idempotent: true });
}

/** Real storage/persistence QA only. A restart is mandatory; this never claims UI Send or inference. */
export async function runAndroidQaAudioImport(cold = false): Promise<void> {
  if (!isAndroidQaAudioStage7Enabled() || active) return;
  active = true;
  publish({ status: 'running', phase: cold ? 'cold_check' : 'importing', steps: [], fixtures: [] });
  const root = `${getAppCacheRootDir()}stage7-import-fixtures/`;
  const receiptUri = `${getAppCacheRootDir()}stage7-import-receipt.json`;
  const drafts: ChatMediaAttachmentDraft[] = [];
  let threadId: string | undefined;
  let previousThreadId = useChatStore.getState().activeThreadId;
  let retain = false;
  try {
    if (cold) {
      const receipt = pendingCleanup ?? await readSmallJson(receiptUri) as Receipt;
      if (receipt.cleanup) {
        const fixtures = fixturesOf(receipt.fixtures);
        await FileSystem.writeAsStringAsync(receiptUri, JSON.stringify(receipt));
        await cleanupOwned(receipt, receiptUri);
        pendingCleanup = undefined;
        publish({ status: receipt.cleanup.coldVerified ? 'passed' : 'failed', phase: 'owned_cleanup_retried',
          fixtures, steps: ['owned_cleanup_retry'], uiSend: 'not_run', inference: 'not_run' });
        return;
      }
      check(receipt.process !== processIdentity, 'cold_restart_required');
      const fixtures = fixturesOf(receipt.fixtures);
      const thread = receipt.threadId ? useChatStore.getState().threads[receipt.threadId] : undefined;
      check(thread?.title === title && thread.messages.length === fixtures.length, 'cold_thread_missing');
      check(thread.messages.every(message => message.attachments?.length === 1), 'cold_attachments_missing');
      const attachments = thread.messages.flatMap(message => message.attachments ?? []);
      for (const [index, fixture] of fixtures.entries()) {
        const attachment = attachments[index];
        check('kind' in attachment && attachment.kind === 'audio' && attachment.source === 'document_picker'
          && attachment.displayName === fixture.name && attachment.sizeBytes === fixture.sizeBytes
          && attachment.audio.format === (fixture.name.endsWith('.mp3') ? 'mp3' : 'wav'), 'cold_metadata_mismatch');
        check(await hash(attachment.localUri) === fixture.sha256, 'cold_bytes_mismatch');
        drafts.push({ kind: 'audio', pickerUri: '', localUri: attachment.localUri, copyStatus: 'copied' });
      }
      threadId = receipt.threadId; previousThreadId = receipt.previousThreadId;
      publish({ fixtures, steps: ['cold_process_hydration', 'cold_names_formats_sizes_hashes'] });
    } else {
      check(!pendingCleanup, 'pending_cleanup');
      check(!(await FileSystem.getInfoAsync(receiptUri)).exists, 'pending_cold_receipt');
      const manifest = await readSmallJson(root + 'manifest.json');
      check(manifest.schemaVersion === 1, 'fixture_manifest_invalid');
      const fixtures = fixturesOf(manifest.fixtures);
      publish({ fixtures });
      for (const fixture of fixtures) {
        check(await hash(root + fixture.name) === fixture.sha256, 'fixture_hash_mismatch');
        const draft = await chatAttachmentStorageService.copyAudioAssetToDraft({ uri: root + fixture.name,
          name: fixture.name, size: fixture.sizeBytes });
        drafts.push(draft);
        check(draft.sizeBytes === fixture.sizeBytes && draft.displayName === fixture.name
          && await hash(draft.localUri!) === fixture.sha256, 'copied_bytes_mismatch');
        if (fixture.name !== names[0]) check((draft.audio?.durationMs ?? 0) > 30_000, 'long_fixture_too_short');
      }
      const store = useChatStore.getState();
      threadId = store.createThread({ modelId: store.threads[previousThreadId ?? '']?.modelId ?? ANDROID_QA_DOCUMENT_MODEL_ID,
        title, presetId: null, presetSnapshot: DEFAULT_PRESET_SNAPSHOT, paramsSnapshot: { temperature: 0, topP: 1, maxTokens: 32, seed: 42 } });
      for (const [index, draft] of drafts.entries()) {
        const messageId = `qa-import-storage-message-${index}`;
        const attachments = materializeMediaDraftsForMessage({ threadId, messageId, drafts: [draft] });
        useChatStore.getState().appendMessage(threadId, { id: messageId, role: 'user', content: 'QA storage import fixture',
          createdAt: Date.now(), state: 'complete', attachments });
      }
      useChatStore.getState().setActiveThread(previousThreadId);
      flushPendingChatPersistenceWrites();
      const record = readChatThreadRecord(getAppStorage(), threadId);
      check(record.ok && record.value.thread.messages.length === fixtures.length
        && record.value.thread.messages.every(message => message.attachments?.length === 1), 'durable_record_missing');
      const directory = getChatAttachmentsDir()!;
      const before = (await FileSystem.readDirectoryAsync(directory)).sort();
      let boundaries = 0; let cancelled = false;
      try {
        const unexpected = await chatAttachmentStorageService.copyAudioAssetToDraft({ uri: root + fixtures[1].name, name: fixtures[1].name }, {
          assertCurrent: () => { if (++boundaries === 3) throw new Error('qa_owner_changed'); },
        });
        drafts.push(unexpected);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'cleanup_failed') throw error;
        cancelled = error instanceof Error && error.message === 'qa_owner_changed';
      }
      check(cancelled && JSON.stringify((await FileSystem.readDirectoryAsync(directory)).sort()) === JSON.stringify(before), 'cancel_rollback_failed');
      await FileSystem.writeAsStringAsync(receiptUri, JSON.stringify({ process: processIdentity, threadId, previousThreadId, fixtures }));
      retain = true;
      publish({ status: 'awaiting_restart', phase: 'force_stop_then_cold_check', fixtures,
        steps: ['real_managed_import', 'send_materialization_only', 'durable_chat_record', 'owner_cancel_copy_rollback'] });
    }
  } catch (error) {
    publish({ status: 'failed', phase: error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : 'import_qa_failed' });
  } finally {
    if (!retain && (threadId || !cold && drafts.length)) {
      try {
        const receipt: Receipt = { process: processIdentity, threadId, previousThreadId, fixtures: evidence.fixtures,
          cleanup: { ownedUris: drafts.map(draft => draft.localUri!), coldVerified: cold && evidence.status !== 'failed' } };
        pendingCleanup = receipt;
        // Durable ownership precedes deletion; retries do not re-hash already deleted files.
        await FileSystem.writeAsStringAsync(receiptUri, JSON.stringify(receipt));
        await cleanupOwned(receipt, receiptUri);
        pendingCleanup = undefined;
        if (evidence.status !== 'failed') publish({ status: 'passed', phase: 'cold_verified_and_cleaned', steps: [...evidence.steps, 'owned_copy_thread_cleanup'] });
      } catch { publish({ status: 'failed', phase: 'cleanup_failed' }); }
    }
    active = false;
  }
}
