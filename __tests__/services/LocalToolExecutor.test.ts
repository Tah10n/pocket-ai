import { executeLocalTool, getLocalToolDefinitions, LOCAL_TOOL_DEFINITIONS, type LocalToolExecutionContext } from '../../src/services/LocalToolExecutor';
import { LOCAL_TOOL_LIMITS, utf8Bytes } from '../../src/services/LocalToolLimits';
import type { LocalToolSettings } from '../../src/types/localTools';
import type { ChatThread } from '../../src/types/chat';

const mockState: { activeThreadId: string; threads: Record<string, Partial<ChatThread>> } = { activeThreadId: 'thread', threads: {} };
const mockSearch = jest.fn();
jest.mock('../../src/store/chatStore', () => ({ useChatStore: { getState: () => ({ ...mockState, getThread: (id: string) => mockState.threads[id] }) } }));
jest.mock('../../src/services/DocumentToolSearch', () => ({
  searchAttachedDocuments: (...args: unknown[]) => mockSearch(...args),
  DocumentToolSearchError: class extends Error {},
}));
const settings: LocalToolSettings = { enabled: true, allowedTools: ['calculate', 'get_current_datetime', 'search_attached_documents'] };
const context = (): LocalToolExecutionContext => ({ runId: 'run', threadId: 'thread', settings,
  signal: new AbortController().signal, assertCurrent: jest.fn() });
const call = (name: string, args: string) => {
  const proposal = { id: 'call', name, arguments: args };
  if (mockState.threads.thread) mockState.threads.thread.messages = [{
    id: 'run', role: 'assistant', content: '', createdAt: 1, state: 'streaming',
    toolRun: { id: 'run', threadId: 'thread', settings, phase: 'tools', status: 'running',
      rounds: [{ index: 0, content: '', calls: [{ ...proposal, status: 'running' }] }] },
  }];
  return proposal;
};

describe('LocalToolExecutor', () => {
  beforeEach(() => { mockState.activeThreadId = 'thread'; mockState.threads = { thread: { toolSettings: settings, messages: [] } }; mockSearch.mockReset(); });
  it('executes an allowed real calculation', async () => {
    expect(JSON.parse(await executeLocalTool(call('calculate', '{"expression":"(12+3)*2"}'), context())))
      .toEqual({ ok: true, result: { value: 30 } });
  });
  test.each([
    ['unknown', '{}', 'not_allowed'], ['calculate', '{"expression":', 'invalid_arguments'],
    ['calculate', '{"expression":12}', 'invalid_arguments'], ['calculate', '{"expression":"1","path":"secret"}', 'invalid_arguments'],
    ['calculate', 'null', 'invalid_arguments'], ['calculate', '{}', 'invalid_arguments'],
    ['get_current_datetime', '{"timeZone":null}', 'invalid_arguments'],
    ['search_attached_documents', '{"query":"x","documentIds":[1]}', 'invalid_arguments'],
    ['search_attached_documents', '{"query":"x","documentIds":[]}', 'invalid_arguments'],
  ])('rejects %s %s', async (name, args, category) => {
    expect(JSON.parse(await executeLocalTool(call(name, args), context()))).toMatchObject({ ok: false, error: { category } });
    expect(mockSearch).not.toHaveBeenCalled();
  });
  it('requires captured and live permissions and an existing chat', async () => {
    const args = call('calculate', '{"expression":"2"}');
    expect(JSON.parse(await executeLocalTool(args, { ...context(), settings: { ...settings, allowedTools: [] } }))).toHaveProperty('ok', false);
    mockState.threads.thread.toolSettings = { ...settings, enabled: false };
    expect(JSON.parse(await executeLocalTool(args, context()))).toHaveProperty('ok', false);
    delete mockState.threads.thread;
    expect(JSON.parse(await executeLocalTool(args, context()))).toHaveProperty('ok', false);
  });
  it('rejects stale run ownership and cancellation before execution', async () => {
    const args = call('calculate', '{"expression":"2"}');
    expect(JSON.parse(await executeLocalTool(args, { ...context(), assertCurrent: () => { throw new Error('private run context'); } })))
      .toEqual({ ok: false, error: { category: 'tool_failed', message: 'Local tool execution could not complete.' } });
    const controller = new AbortController(); controller.abort();
    expect(JSON.parse(await executeLocalTool(args, { ...context(), signal: controller.signal }))).toMatchObject({ error: { category: 'cancelled' } });
  });
  it('suppresses late success after permission revocation', async () => {
    let resolve!: (value: object) => void;
    mockSearch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const result = executeLocalTool(call('search_attached_documents', '{"query":"word"}'), context());
    mockState.threads.thread.toolSettings = { ...settings, enabled: false };
    resolve({ matches: [{ text: 'private excerpt' }] });
    const response = await result;
    expect(JSON.parse(response)).toMatchObject({ ok: false, error: { category: 'not_allowed' } });
    expect(response).not.toContain('private excerpt');
  });
  it('requires a running matching proposal in the active chat and run', async () => {
    const args = call('calculate', '{"expression":"2"}');
    mockState.activeThreadId = 'other';
    expect(JSON.parse(await executeLocalTool(args, context()))).toMatchObject({ error: { category: 'not_allowed' } });
    mockState.activeThreadId = 'thread';
    expect(JSON.parse(await executeLocalTool({ ...args, arguments: '{"expression":"3"}' }, context()))).toMatchObject({ error: { category: 'not_allowed' } });
    mockState.threads.thread.messages![0].toolRun!.rounds[0].calls[0].status = 'completed';
    expect(JSON.parse(await executeLocalTool(args, context()))).toMatchObject({ error: { category: 'not_allowed' } });
  });
  it('bounds UTF-8 arguments and results rather than only JS string length', async () => {
    const args = JSON.stringify({ query: 'я'.repeat(2200) });
    expect(JSON.parse(await executeLocalTool(call('search_attached_documents', args), context()))).toHaveProperty('ok', false);
    mockSearch.mockResolvedValue({ matches: ['я'.repeat(LOCAL_TOOL_LIMITS.resultBytes)] });
    expect(JSON.parse(await executeLocalTool(call('search_attached_documents', '{"query":"word"}'), context())))
      .toMatchObject({ error: { category: 'result_limit' } });
    expect(utf8Bytes('aя😀\ud800')).toBe(10);
  });
  it('bounds tool errors without echoing arguments or native failures', async () => {
    mockSearch.mockRejectedValue(new Error('private document path and content'));
    const result = await executeLocalTool(call('search_attached_documents', '{"query":"private-secret"}'), context());
    expect(result).not.toContain('private');
    expect(JSON.parse(await executeLocalTool(call('calculate', '{"expression":"1/0"}'), context())))
      .toMatchObject({ error: { category: 'division_by_zero' } });
  });
  it('returns only configured immutable built-in definitions', () => {
    expect(getLocalToolDefinitions({ enabled: false, allowedTools: settings.allowedTools })).toEqual([]);
    expect(getLocalToolDefinitions({ enabled: true, allowedTools: ['calculate'] }).map(item => item.function.name)).toEqual(['calculate']);
    expect(Object.isFrozen(LOCAL_TOOL_DEFINITIONS[0].function.parameters)).toBe(true);
  });
});

it('describes optional document IDs as actual context IDs without changing the required query contract', () => {
  const definition = getLocalToolDefinitions(settings).find(tool => tool.function.name === 'search_attached_documents');
  expect(definition).toHaveProperty('function.parameters.required', ['query']);
  expect(definition).toHaveProperty('function.parameters.properties.documentIds.description',
    'Optional. Omit to search this chat; use only actual attached document IDs provided in context. Never invent IDs.');
});
