import * as FileSystem from 'expo-file-system/legacy';
import { runAndroidQaAudioImport, getAndroidQaAudioImportEvidence } from '../../src/services/AndroidQaAudioImport';
import { chatAttachmentStorageService } from '../../src/services/ChatAttachmentStorageService';

let mockEnabled = true;
const mockRoot = 'file:///data/user/0/app.qa/cache/';
const mockNames = ['over-four-MiB.wav', 'forty-seconds.wav', 'legacy-import.mp3'];
const mockFixtures = mockNames.map((name, index) => ({ name, sizeBytes: [4608044, 1280044, 640000][index], sha256: 'a'.repeat(64) }));
const mockFiles = new Map<string, string>();
const mockThreads: Record<string, any> = {};
let mockActive: string | null = 'prior';
let mockCopyId = 0;
const mockCreate = jest.fn(() => { mockThreads.owned = { title: 'QA audio import storage only', messages: [] }; return 'owned'; });
const mockDelete = jest.fn((id: string) => { delete mockThreads[id]; });
jest.mock('../../src/services/AndroidQaAudioStage7', () => ({ isAndroidQaAudioStage7Enabled: () => mockEnabled }));
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-base' }));
jest.mock('../../src/services/FileSystemSetup', () => ({ getAppCacheRootDir: () => mockRoot }));
jest.mock('../../src/store/storage', () => ({ getAppStorage: () => ({}) }));
jest.mock('../../src/store/chatPersistence', () => ({ readChatThreadRecord: (_storage: unknown, id: string) => ({ ok: true, value: { thread: mockThreads[id] } }) }));
jest.mock('../../src/store/chatStore', () => ({ flushPendingChatPersistenceWrites: jest.fn(), useChatStore: { getState: () => ({
  threads: mockThreads, activeThreadId: mockActive, createThread: mockCreate, deleteThread: mockDelete,
  appendMessage: (id: string, message: unknown) => mockThreads[id].messages.push(message),
  setActiveThread: (id: string | null) => { mockActive = id; },
}) } }));
jest.mock('../../src/services/ChatAttachmentStorageService', () => ({ getChatAttachmentsDir: () => 'test-dir/chat-attachments/',
  materializeMediaDraftsForMessage: ({ drafts }: { drafts: unknown[] }) => drafts,
  chatAttachmentStorageService: { copyAudioAssetToDraft: jest.fn(), discardMediaDrafts: jest.fn() } }));
jest.mock('react-native-fs', () => ({ hash: jest.fn(async () => 'a'.repeat(64)) }));

beforeEach(() => {
  jest.clearAllMocks(); mockEnabled = true; mockFiles.clear(); mockCopyId = 0; mockActive = 'prior';
  for (const key of Object.keys(mockThreads)) delete mockThreads[key];
  mockThreads.prior = { modelId: 'existing', messages: [{ content: 'preserve prior user work' }] };
  mockFiles.set(mockRoot + 'stage7-import-fixtures/manifest.json', JSON.stringify({ schemaVersion: 1, fixtures: mockFixtures }));
  (FileSystem.getInfoAsync as jest.Mock).mockImplementation(async uri => ({ exists: mockFiles.has(uri), size: mockFiles.get(uri)?.length ?? 0 }));
  (FileSystem.readAsStringAsync as jest.Mock).mockImplementation(async uri => mockFiles.get(uri));
  (FileSystem.writeAsStringAsync as jest.Mock).mockImplementation(async (uri, contents) => { mockFiles.set(uri, contents); });
  (FileSystem.deleteAsync as jest.Mock).mockImplementation(async uri => { mockFiles.delete(uri); });
  (FileSystem.readDirectoryAsync as jest.Mock).mockImplementation(async () => [...mockFiles.keys()].filter(uri => uri.startsWith('test-dir/chat-attachments/')));
  jest.mocked(chatAttachmentStorageService.copyAudioAssetToDraft).mockImplementation(async (asset, options) => {
    for (let i = 0; i < 3; i++) options?.assertCurrent?.();
    const fixture = mockFixtures.find(item => item.name === asset.name)!;
    const uri = `test-dir/chat-attachments/draft-123-${++mockCopyId}.wav`; mockFiles.set(uri, 'audio');
    return { kind: 'audio', localUri: uri, pickerUri: asset.uri, displayName: asset.name, sizeBytes: fixture.sizeBytes,
      source: 'document_picker', copyStatus: 'copied', audio: { format: asset.name.endsWith('.mp3') ? 'mp3' : 'wav', durationMs: 40000 } };
  });
  jest.mocked(chatAttachmentStorageService.discardMediaDrafts).mockImplementation(async drafts => { for (const draft of drafts) mockFiles.delete(draft.localUri!); });
});

it('keeps the real import/storage APIs and explicit non-UI evidence, requiring another process before cleanup', async () => {
  await runAndroidQaAudioImport();
  expect(getAndroidQaAudioImportEvidence()).toMatchObject({ status: 'awaiting_restart', uiSend: 'not_run', inference: 'not_run' });
  expect(chatAttachmentStorageService.copyAudioAssetToDraft).toHaveBeenCalledTimes(4);
  expect(mockThreads.owned.messages).toHaveLength(3);
  expect(mockThreads.owned.messages.every((message: any) => message.attachments.length === 1)).toBe(true);
  expect(mockActive).toBe('prior');
  await runAndroidQaAudioImport(true);
  expect(getAndroidQaAudioImportEvidence()).toMatchObject({ status: 'failed', phase: 'cold_restart_required' });
  expect(mockDelete).not.toHaveBeenCalled();
});

it('checks cold metadata and hashes then deletes only the QA-owned thread and copies', async () => {
  await runAndroidQaAudioImport();
  const uri = mockRoot + 'stage7-import-receipt.json';
  const receipt = JSON.parse(mockFiles.get(uri)!); receipt.process = 'previous-process'; mockFiles.set(uri, JSON.stringify(receipt));
  await runAndroidQaAudioImport(true);
  expect(getAndroidQaAudioImportEvidence()).toMatchObject({ status: 'passed', phase: 'cold_verified_and_cleaned' });
  expect(mockDelete).toHaveBeenCalledWith('owned');
  expect(mockThreads.prior.messages[0].content).toBe('preserve prior user work');
  expect([...mockFiles.keys()].some(key => key.startsWith('test-dir/chat-attachments/'))).toBe(false);
  expect(mockFiles.has(uri)).toBe(false);
  expect(mockFiles.has(mockRoot + 'stage7-import-fixtures/manifest.json')).toBe(true);
});

it('does not touch files in ordinary builds or delete a pending unverified cold receipt', async () => {
  mockEnabled = false; await runAndroidQaAudioImport();
  expect(FileSystem.getInfoAsync).not.toHaveBeenCalled();
  mockEnabled = true; mockFiles.set(mockRoot + 'stage7-import-receipt.json', '{}');
  await runAndroidQaAudioImport();
  expect(getAndroidQaAudioImportEvidence()).toMatchObject({ status: 'failed', phase: 'pending_cold_receipt' });
  expect(mockCreate).not.toHaveBeenCalled(); expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});


it.each(['partial_file_delete', 'receipt_delete'])('retries verified cold cleanup after %s without re-hashing missing files', async fault => {
  await runAndroidQaAudioImport();
  const uri = mockRoot + 'stage7-import-receipt.json';
  const receipt = JSON.parse(mockFiles.get(uri)!); receipt.process = 'previous-process'; mockFiles.set(uri, JSON.stringify(receipt));
  let calls = 0;
  (FileSystem.deleteAsync as jest.Mock).mockImplementation(async target => {
    calls++;
    if (fault === 'partial_file_delete' && calls === 2 || fault === 'receipt_delete' && target === uri) throw new Error('disk_error');
    mockFiles.delete(target);
  });
  await runAndroidQaAudioImport(true);
  expect(getAndroidQaAudioImportEvidence()).toMatchObject({ status: 'failed', phase: 'cleanup_failed' });
  expect(JSON.parse(mockFiles.get(uri)!).cleanup.coldVerified).toBe(true);
  (FileSystem.deleteAsync as jest.Mock).mockImplementation(async target => { mockFiles.delete(target); });
  await runAndroidQaAudioImport(true);
  expect(getAndroidQaAudioImportEvidence()).toMatchObject({ status: 'passed', phase: 'owned_cleanup_retried' });
  expect(mockFiles.has(uri)).toBe(false); expect(mockThreads.owned).toBeUndefined();
  expect(mockThreads.prior.messages[0].content).toBe('preserve prior user work');
});
