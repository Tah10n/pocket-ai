import type { LlamaContext } from 'llama.rn';
import { PreparedLlamaRequestCache } from '../../src/services/PreparedLlamaRequest';
import { freezeGenerationParameters } from '../../src/utils/generationControls';

function setup() {
  const getFormattedChat = jest.fn().mockResolvedValue({
    type: 'jinja', prompt: '<bos>user<assistant>', additional_stops: ['  END  '], has_media: false,
    grammar: 'template grammar', grammar_lazy: true, grammar_triggers: [{ type: 0, value: 'x', token: 1 }],
    preserved_tokens: ['keep'], chat_format: 1, chat_parser: 'parser', generation_prompt: '<assistant>',
    thinking_start_tag: '<think>', thinking_end_tag: '</think>', thinking_forced_open: false,
  });
  // Only the formatter is used by this helper; lifecycle tests cover full contexts.
  const context = { getFormattedChat } as unknown as LlamaContext;
  const cache = new PreparedLlamaRequestCache();
  const request = {
    context, epoch: 1, messages: [{ role: 'user' as const, content: 'Question' }],
    generation: freezeGenerationParameters({}, 100), enableThinking: false, reasoningFormat: 'none' as const,
  };
  return { cache, getFormattedChat, request };
}

describe('one prepared llama request for counting and completion', () => {
  it.each([
    { now: 0 }, { kwargs: { value: false } }, { addGenerationPrompt: false },
    { forcePureContent: true }, { chatTemplate: '{{ custom }}', jinja: true },
  ])('rejects options the actual legacy formatter cannot apply: %o', async (template) => {
    const { cache, getFormattedChat, request } = setup();
    getFormattedChat.mockResolvedValue({ type: 'llama-chat', prompt: 'legacy' });
    await expect(cache.prepare({ ...request, generation: freezeGenerationParameters({ template }, 100) }))
      .rejects.toThrow('compatible Jinja');
  });

  it('retains legacy defaults while keeping automatic time private to the request', async () => {
    const { cache, getFormattedChat, request } = setup();
    getFormattedChat.mockResolvedValue({ type: 'llama-chat', prompt: 'legacy' });
    const result = await cache.prepare({ ...request, generation: freezeGenerationParameters({ template: { jinja: false } }, 100) });
    expect(result.completion.prompt).toBe('legacy');
  });
  it('reuses retained assistant prefill without changing history or suppressing a user suffix', async () => {
    const { cache, getFormattedChat, request } = setup();
    getFormattedChat.mockResolvedValue({ type: 'jinja', prompt: '<assistant>{"answer":' });
    const generation = freezeGenerationParameters({ template: { prefillText: '{"answer":', addGenerationPrompt: false } }, 1);
    const messages = [{ role: 'assistant' as const, content: '{"answer":' }];
    const continued = await cache.prepare({ ...request, generation, messages });
    expect(continued.completion).toMatchObject({ prompt: '<assistant>{"answer":', prefill_text: '{"answer":' });
    expect(messages).toEqual([{ role: 'assistant', content: '{"answer":' }]);
    const user = await cache.prepare({ ...request, generation, messages: [{ role: 'user', content: '{"answer":' }] });
    expect(user.completion.prompt).toBe('<assistant>{"answer":{"answer":');
    getFormattedChat.mockResolvedValue({ type: 'jinja', prompt: '<assistant>{"answer":<end><assistant>' });
    const closed = await cache.prepare({ ...request, epoch: 2, generation, messages });
    expect(closed.completion.prompt).toBe('<assistant>{"answer":<end><assistant>{"answer":');
  });

  it('reuses exactly one formatting result including metadata/time/prefill without mutating history', async () => {
    const { cache, getFormattedChat, request } = setup();
    request.generation = freezeGenerationParameters({ template: {
      chatTemplate: 'custom jinja', jinja: true, kwargs: { a: false, n: 0, s: '' },
      now: 0, addGenerationPrompt: false, forcePureContent: true, prefillText: '{"answer":',
    } }, 999);
    const first = await cache.prepare(request);
    const second = await cache.prepare(request);
    expect(first).toBe(second);
    expect(getFormattedChat).toHaveBeenCalledTimes(1);
    expect(getFormattedChat).toHaveBeenCalledWith(request.messages, 'custom jinja', expect.objectContaining({
      jinja: true, now: 0, add_generation_prompt: false, force_pure_content: true, chat_template_kwargs: { a: false, n: 0, s: '' },
    }));
    expect(first.completion).toMatchObject({
      prompt: '<bos>user<assistant>{"answer":', prefill_text: '{"answer":',
      generation_prompt: '<assistant>', chat_parser: 'parser',
      thinking_start_tag: '<think>', thinking_end_tag: '</think>',
    });
    expect(first.completion.messages).toBeUndefined();
    expect(request.messages).toEqual([{ role: 'user', content: 'Question' }]);
    expect(first.formatted.additional_stops).toEqual(['  END  ']);
  });

  it('makes explicit grammar win over template grammar without inheriting lazy triggers', async () => {
    const { cache, request } = setup();
    const grammar = 'root ::= "ok"\n';
    const prepared = await cache.prepare({ ...request, generation: freezeGenerationParameters({ output: { mode: 'gbnf', grammar } }, 1) });
    expect(prepared.completion).toMatchObject({ grammar, grammar_lazy: false, grammar_triggers: [], preserved_tokens: [],
      chat_parser: '', chat_format: 0, generation_prompt: '', prefill_text: '', thinking_forced_open: false });
    expect(prepared.formatted.chat_parser).toBe('parser');
  });

  it('keeps GBNF protocol-looking literals as content instead of sending them through the template parser', async () => {
    const { cache, getFormattedChat, request } = setup();
    const literal = '<|open|>think<|sep|>x<|close|>think<|sep|>';
    const grammar = `root ::= ${JSON.stringify(literal)}`;
    getFormattedChat.mockResolvedValue({ type: 'jinja', prompt: 'history<assistant>',
      generation_prompt: '<assistant>', chat_parser: 'kimi-protocol-parser', chat_format: 24,
      thinking_forced_open: true, thinking_start_tag: '<|open|>think<|sep|>', thinking_end_tag: '<|close|>think<|sep|>' });
    const prepared = await cache.prepare({ ...request, generation: freezeGenerationParameters({ output: { mode: 'gbnf', grammar } }, 1) });
    expect(prepared.completion).toMatchObject({ prompt: 'history<assistant>', grammar,
      chat_parser: '', chat_format: 0, generation_prompt: '', prefill_text: '',
      thinking_forced_open: false, thinking_start_tag: '', thinking_end_tag: '' });
    expect(prepared.formatted.chat_parser).toBe('kimi-protocol-parser');
    // Empty native parser captures p.rest() as content, with no framing prefix.
    expect((prepared.completion.generation_prompt ?? '') + (prepared.completion.prefill_text ?? '') + literal).toBe(literal);
  });

  it('makes explicit JSON constraints win over template grammar and disables incompatible thinking', async () => {
    const { cache, getFormattedChat, request } = setup();
    const prepared = await cache.prepare({ ...request, enableThinking: true, reasoningFormat: 'auto',
      generation: freezeGenerationParameters({ output: { mode: 'json_schema', schema: '{"type":"boolean"}' } }, 1) });
    expect(prepared.completion).toMatchObject({ grammar: '', json_schema: '{"type":"boolean"}', grammar_lazy: false, enable_thinking: false, reasoning_format: 'none',
      generation_prompt: '', prefill_text: '', chat_parser: '', chat_format: 0, thinking_start_tag: '', thinking_end_tag: '' });
    expect(prepared.formatted).toMatchObject({ generation_prompt: '<assistant>', chat_parser: 'parser', thinking_start_tag: '<think>' });
    expect(getFormattedChat.mock.calls[0][2]).toMatchObject({ enable_thinking: false, reasoning_format: 'none', response_format: { type: 'json_schema' } });
  });

  it('advances bare JSON grammar with the content prefill rather than assistant protocol tokens', async () => {
    const { cache, getFormattedChat, request } = setup();
    getFormattedChat.mockResolvedValue({ type: 'jinja', prompt: '<|im_start|>assistant\n',
      generation_prompt: '<|im_start|>assistant\n', chat_parser: 'protocol parser', chat_format: 24 });
    const prepared = await cache.prepare({ ...request, generation: freezeGenerationParameters({
      output: { mode: 'json_object' }, template: { prefillText: '{"answer":' },
    }, 1) });
    expect(prepared.completion).toMatchObject({ prompt: '<|im_start|>assistant\n{"answer":',
      generation_prompt: '{"answer":', prefill_text: '', chat_parser: '', chat_format: 0 });
    expect(prepared.formatted.generation_prompt).toBe('<|im_start|>assistant\n');
    // common_chat_peg_parse prepends generation_prompt; rn-completion prepends
    // prefill_text before it. This must be exactly one complete JSON object.
    const parserInput = (prepared.completion.generation_prompt ?? '') + (prepared.completion.prefill_text ?? '') + '"yes"}';
    expect(JSON.parse(parserInput)).toEqual({ answer: 'yes' });
  });

  it('rejects unsupported GBNF content prefill before invoking the formatter', async () => {
    const { cache, getFormattedChat, request } = setup();
    await expect(cache.prepare({ ...request, generation: freezeGenerationParameters({
      output: { mode: 'gbnf', grammar: 'root ::= "yes"' }, template: { prefillText: 'y' },
    }, 1) })).rejects.toThrow('GBNF cannot be combined');
    expect(getFormattedChat).not.toHaveBeenCalled();
  });

  it('invalidates formatting on each changed template input, output constraint or context epoch', async () => {
    const { cache, getFormattedChat, request } = setup();
    await cache.prepare(request);
    for (const template of [{ now: 101 }, { now: 100, chatTemplate: 'other' }, { now: 100, kwargs: { x: 1 } },
      { now: 100, prefillText: 'a' }, { now: 100, jinja: false }, { now: 100, forcePureContent: true }]) {
      await cache.prepare({ ...request, generation: { template } });
    }
    await cache.prepare({ ...request, generation: { template: { now: 100 }, output: { mode: 'json_object' } } });
    await cache.prepare({ ...request, epoch: 2 });
    expect(getFormattedChat).toHaveBeenCalledTimes(9);
  });

  it('does not poison the next ordinary request after invalid schema or formatter errors', async () => {
    const { cache, getFormattedChat, request } = setup();
    await expect(cache.prepare({ ...request, generation: { output: { mode: 'json_schema', schema: '{' } } })).rejects.toThrow();
    expect(getFormattedChat).not.toHaveBeenCalled();
    getFormattedChat.mockRejectedValueOnce(new Error('bad template'));
    await expect(cache.prepare(request)).rejects.toThrow('bad template');
    await expect(cache.prepare(request)).resolves.toHaveProperty('completion.prompt', '<bos>user<assistant>');
  });

  it('does not repopulate a replaced context cache when a deferred formatter settles late', async () => {
    const { cache, getFormattedChat, request } = setup();
    let finish!: (result: object) => void;
    getFormattedChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const old = cache.prepare(request);
    await cache.prepare({ ...request, epoch: 2 });
    finish({ prompt: 'stale', additional_stops: [] });
    await old;
    const current = await cache.prepare({ ...request, epoch: 2 });
    expect(current.completion.prompt).toBe('<bos>user<assistant>');
    expect(getFormattedChat).toHaveBeenCalledTimes(2);
  });

  it('evicts old entries from a bounded cache', async () => {
    const { cache, getFormattedChat, request } = setup();
    for (let now = 0; now < 10; now++) await cache.prepare({ ...request, generation: { template: { now } } });
    await cache.prepare({ ...request, generation: { template: { now: 0 } } });
    expect(getFormattedChat).toHaveBeenCalledTimes(11);
  });
});
