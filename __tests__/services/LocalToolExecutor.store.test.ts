import { useChatStore, flushPendingChatPersistenceWrites, resetChatStoreForPrivateStorageReset } from '../../src/store/chatStore';
import { storage } from '../../src/store/storage';
import { executeLocalTool } from '../../src/services/LocalToolExecutor';
import { searchAttachedDocuments } from '../../src/services/DocumentToolSearch';
import type { ChatThread } from '../../src/types/chat';
import type { LocalToolSettings, LocalToolRun } from '../../src/types/localTools';
import { getChatAttachmentsDir } from '../../src/utils/chatImageAttachments';
import type { ChatAttachment } from '../../src/types/attachments';

const settings: LocalToolSettings = { enabled: true, allowedTools: ['calculate', 'search_attached_documents'] };
const mockProcess = jest.fn();
jest.mock('../../src/services/ChatAttachmentProcessorRegistry', () => ({ chatAttachmentProcessorRegistry: {
  processDocumentTextAttachment: (...args: unknown[]) => mockProcess(...args),
} }));

function thread(): ChatThread {
  return { id: 'thread', title: 'Thread', modelId: 'model', presetId: null,
    presetSnapshot: { id: null, name: 'Default', systemPrompt: '' },
    paramsSnapshot: { temperature: 0.7, topP: 0.9, maxTokens: 512, seed: null },
    toolSettings: settings, status: 'idle', createdAt: 1, updatedAt: 1,
    messages: [{ id: 'user', role: 'user', content: 'Calculate', createdAt: 1, state: 'complete' }],
  };
}
function proposal(runId: string): LocalToolRun {
  return { id: runId, threadId: 'thread', settings, status: 'running', phase: 'tools',
    rounds: [{ index: 0, content: '', calls: [{ id: 'call', name: 'calculate', arguments: '{"expression":"7*6"}', status: 'running' }] }] };
}
function execute(runId: string) {
  const run = proposal(runId);
  useChatStore.getState().patchAssistantMessage('thread', runId, { toolRun: run });
  return executeLocalTool(run.rounds[0].calls[0], { runId, threadId: 'thread', settings,
    signal: new AbortController().signal, assertCurrent: () => undefined });
}

describe('LocalToolExecutor actual chat store integration', () => {
  beforeEach(() => {
    flushPendingChatPersistenceWrites('background'); resetChatStoreForPrivateStorageReset();
    storage.getAllKeys().forEach(key => storage.remove(key));
    useChatStore.setState({ threads: { thread: thread() }, activeThreadId: 'thread' });
    mockProcess.mockClear();
  });
  afterEach(() => { flushPendingChatPersistenceWrites('background'); resetChatStoreForPrivateStorageReset(); });
  it('authorizes a proposal written into the actual transient assistant runtime', async () => {
    const runId = useChatStore.getState().createAssistantPlaceholder('thread', 'model');
    expect(JSON.parse(await execute(runId))).toEqual({ ok: true, result: { value: 42 } });
    expect(useChatStore.getState().threads.thread.messages.some(message => message.toolRun)).toBe(false);
    expect(useChatStore.getState().getThread('thread')?.messages.at(-1)?.toolRun?.id).toBe(runId);
  });
  it('authorizes explicit regeneration under its new transient ID and rejects the old run', async () => {
    const original = useChatStore.getState().createAssistantPlaceholder('thread', 'model');
    await execute(original);
    useChatStore.getState().finalizeAssistantMessage('thread', original, '42');
    const replacement = useChatStore.getState().replaceLastAssistantMessage('thread');
    expect(replacement).not.toBeNull();
    expect(JSON.parse(await execute(replacement!))).toHaveProperty('ok', true);
    expect(JSON.parse(await executeLocalTool(proposal(original).rounds[0].calls[0], {
      runId: original, threadId: 'thread', settings, signal: new AbortController().signal, assertCurrent: () => undefined,
    }))).toMatchObject({ error: { category: 'not_allowed' } });
  });
  it('excludes documents in the durable suffix while a replacement branch is active', async () => {
    const document: ChatAttachment = { id: 'suffix-document', kind: 'document', threadId: 'thread', messageId: 'later', state: 'ready',
      localUri: getChatAttachmentsDir() + 'suffix.txt', fileName: 'suffix.txt', pathCategory: 'chat_attachment',
      mimeType: 'text/plain', sizeBytes: 20, source: 'document_picker', createdAt: 3,
      document: { processorId: 'document-text', processorVersion: 3 } };
    const original = thread();
    original.messages.push({ id: 'first-answer', role: 'assistant', content: 'old', createdAt: 2, state: 'complete' },
      { id: 'later', role: 'user', content: 'later', createdAt: 3, state: 'complete', attachments: [document] },
      { id: 'later-answer', role: 'assistant', content: 'later answer', createdAt: 4, state: 'complete' });
    useChatStore.setState({ threads: { thread: thread() }, activeThreadId: 'thread' });
    original.messages.slice(1).forEach(message => useChatStore.getState().appendMessage('thread', message));
    flushPendingChatPersistenceWrites('background');
    const replacement = useChatStore.getState().replaceBranchFromUserMessage('thread', 'user', 'New branch');
    expect(replacement).not.toBeNull();
    expect(useChatStore.getState().threads.thread.messages.some(message => message.id === 'later')).toBe(true);
    expect(useChatStore.getState().getThread('thread')?.messages.some(message => message.id === 'later')).toBe(false);
    await expect(searchAttachedDocuments('suffix', ['suffix-document'], { threadId: 'thread', signal: new AbortController().signal,
      assertCurrent: () => undefined })).rejects.toHaveProperty('category', 'document_unavailable');
    expect(mockProcess).not.toHaveBeenCalled();
    expect(JSON.parse(await execute(replacement!))).toHaveProperty('ok', true);
  });
});
