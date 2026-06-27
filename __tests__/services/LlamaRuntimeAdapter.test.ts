import type { LlamaContext } from 'llama.rn';
import {
  getFormattedChatFromContext,
  getMultimodalSupportFromContext,
  initMultimodalOnContext,
  normalizeBackendDeviceInfoList,
  normalizeCompletionResult,
  normalizeLlamaMessages,
  releaseMultimodalFromContext,
  runCompletionOnContext,
} from '../../src/services/LlamaRuntimeAdapter';

function createContext(overrides: Record<string, unknown>): LlamaContext {
  return overrides as unknown as LlamaContext;
}

describe('LlamaRuntimeAdapter', () => {
  it('normalizes formatted chat payloads from llama.rn', async () => {
    const getFormattedChat = jest.fn().mockResolvedValue({
      type: ' jinja ',
      prompt: 'Formatted prompt',
      media_paths: [' /tmp/image.png ', 42, ''],
      additional_stops: [' </s> ', 12, '<|done|>', ''],
      thinking_start_tag: '<think>',
      thinking_end_tag: '</think>',
      thinking_forced_open: false,
    });
    const context = createContext({ getFormattedChat });

    const result = await getFormattedChatFromContext({
      context,
      messages: [{ role: 'user', content: 'Hello' }],
      options: {
        enable_thinking: true,
        reasoning_format: 'auto',
      },
    });

    expect(getFormattedChat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      null,
      expect.objectContaining({
        enable_thinking: true,
        reasoning_format: 'auto',
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      type: 'jinja',
      prompt: 'Formatted prompt',
      has_media: true,
      media_paths: ['/tmp/image.png'],
      additional_stops: ['</s>', '<|done|>'],
      thinking_start_tag: '<think>',
      thinking_end_tag: '</think>',
      thinking_forced_open: false,
    }));
  });

  it('rejects malformed formatted chat payloads before engine code uses them', async () => {
    const context = createContext({
      getFormattedChat: jest.fn().mockResolvedValue({ additional_stops: ['</s>'] }),
    });

    await expect(getFormattedChatFromContext({
      context,
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toThrow('prompt must be a string');
  });

  it('normalizes token callbacks and validates completion results', async () => {
    const completion = jest.fn(async (_params, onToken) => {
      onToken?.({
        content: 'visible',
        reasoning_content: 'reason',
        accumulated_text: 'visible',
      });
      return { text: 'done' };
    });
    const context = createContext({ completion });
    const onToken = jest.fn();

    await expect(runCompletionOnContext({
      context,
      params: {
        messages: [{ role: 'user', content: 'Hello' }],
        n_predict: 8,
      },
      onToken,
    })).resolves.toEqual({ text: 'done' });

    expect(onToken).toHaveBeenCalledWith({
      token: '',
      content: 'visible',
      reasoning_content: 'reason',
      accumulated_text: 'visible',
    });
  });

  it('rejects invalid completion result scalar fields', () => {
    expect(() => normalizeCompletionResult({ text: 123 })).toThrow('text must be a string');
  });

  it('rejects malformed token callback scalar fields', async () => {
    const context = createContext({
      completion: jest.fn(async (_params, onToken) => {
        onToken?.({ token: 123 });
        return { text: 'unreachable' };
      }),
    });

    await expect(runCompletionOnContext({
      context,
      params: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
      onToken: jest.fn(),
    })).rejects.toThrow('token must be a string');
  });

  it('normalizes backend device discovery results', () => {
    expect(normalizeBackendDeviceInfoList([
      {
        backend: ' OpenCL ',
        type: ' gpu ',
        deviceName: ' Adreno ',
        maxMemorySize: 1024,
        metadata: { vendor: 'qualcomm' },
      },
      {
        backend: 'HTP',
        type: 'gpu',
        deviceName: '',
        maxMemorySize: 1024,
      },
      'bad',
      null,
    ])).toEqual([
      {
        backend: 'OpenCL',
        type: 'gpu',
        deviceName: 'Adreno',
        maxMemorySize: 1024,
        metadata: { vendor: 'qualcomm' },
      },
    ]);
  });

  it('keeps empty string message content as a valid native chat message', () => {
    expect(normalizeLlamaMessages([{ role: 'user', content: '' }])).toEqual([
      { role: 'user', content: '' },
    ]);
  });

  it('normalizes user media paths into llama.rn image content parts', () => {
    expect(normalizeLlamaMessages([
      { role: 'user', content: 'Describe this', mediaPaths: [' /document/image.jpg ', ''] },
      { role: 'assistant', content: 'Sure' },
    ])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: '/document/image.jpg' } },
        ],
      },
      { role: 'assistant', content: 'Sure' },
    ]);
  });

  it('normalizes structured image and audio content parts for user messages', () => {
    expect(normalizeLlamaMessages([
      {
        role: 'user',
        content: 'Use these attachments',
        contentParts: [
          { type: 'image_url', image_url: { url: ' file:///document/image.jpg ' } },
          { type: 'input_audio', input_audio: { format: 'wav', url: ' file:///document/audio.wav ' } },
          { type: 'input_audio', input_audio: { format: 'mp3', data: 'base64-audio-payload' } },
        ],
      },
    ])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Use these attachments' },
          { type: 'image_url', image_url: { url: 'file:///document/image.jpg' } },
          { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
          { type: 'input_audio', input_audio: { format: 'mp3', data: 'base64-audio-payload' } },
        ],
      },
    ]);
  });

  it('keeps message text before structured text content parts', () => {
    expect(normalizeLlamaMessages([
      {
        role: 'user',
        content: 'Summarize the attachment',
        contentParts: [
          { type: 'text', text: 'Document attachment text\n\nQuarterly notes' },
        ],
      },
    ])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize the attachment' },
          { type: 'text', text: 'Document attachment text\n\nQuarterly notes' },
        ],
      },
    ]);
  });

  it('does not duplicate message text already represented as a structured text part', () => {
    expect(normalizeLlamaMessages([
      {
        role: 'user',
        content: 'Already structured',
        contentParts: [
          { type: 'text', text: ' Already structured ' },
        ],
      },
    ])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: ' Already structured ' },
        ],
      },
    ]);
  });

  it('rejects malformed structured audio content parts before native calls', () => {
    expect(() => normalizeLlamaMessages([
      {
        role: 'user',
        content: 'Listen',
        contentParts: [
          { type: 'input_audio', input_audio: { format: 'aac', url: 'file:///document/audio.aac' } } as never,
        ],
      },
    ])).toThrow('input_audio.format must be wav or mp3');

    expect(() => normalizeLlamaMessages([
      {
        role: 'user',
        content: 'Listen',
        contentParts: [
          { type: 'input_audio', input_audio: { format: 'wav' } },
        ],
      },
    ])).toThrow('must include exactly one of url or data');
  });

  it('rejects media content parts on non-user messages', () => {
    expect(() => normalizeLlamaMessages([
      {
        role: 'assistant',
        content: 'No media here',
        contentParts: [
          { type: 'image_url', image_url: { url: 'file:///document/image.jpg' } },
        ],
      },
    ])).toThrow('media contentParts are only supported for user messages');
  });

  it('normalizes completion messages before calling the native runtime', async () => {
    const completion = jest.fn().mockResolvedValue({ text: 'done' });
    const context = createContext({ completion });

    await runCompletionOnContext({
      context,
      params: {
        messages: [{ role: 'user', content: 'Describe', mediaPaths: ['/document/image.jpg'] }] as never,
        n_predict: 8,
      },
    });

    expect(completion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: '/document/image.jpg' } },
          ],
        }],
      }),
      undefined,
    );
  });

  it('normalizes structured completion content before calling the native runtime', async () => {
    const completion = jest.fn().mockResolvedValue({ text: 'done' });
    const context = createContext({ completion });

    await runCompletionOnContext({
      context,
      params: {
        messages: [{
          role: 'user',
          content: 'Transcribe this',
          contentParts: [
            { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
          ],
        }] as never,
        n_predict: 8,
      },
    });

    expect(completion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this' },
            { type: 'input_audio', input_audio: { format: 'wav', url: 'file:///document/audio.wav' } },
          ],
        }],
      }),
      undefined,
    );
  });

  it('wraps llama.rn multimodal lifecycle helpers with feature checks', async () => {
    const initMultimodal = jest.fn().mockResolvedValue(true);
    const getMultimodalSupport = jest.fn().mockResolvedValue({ vision: true, audio: false });
    const releaseMultimodal = jest.fn().mockResolvedValue(undefined);
    const context = createContext({
      initMultimodal,
      getMultimodalSupport,
      releaseMultimodal,
    });

    await expect(initMultimodalOnContext({
      context,
      path: 'file:///document/mmproj.gguf',
      useGpu: false,
      imageMinTokens: 256,
      imageMaxTokens: 512,
    })).resolves.toBe(true);
    await expect(getMultimodalSupportFromContext(context)).resolves.toEqual({
      vision: true,
      audio: false,
    });
    await expect(releaseMultimodalFromContext(context)).resolves.toBeUndefined();

    expect(initMultimodal).toHaveBeenCalledWith({
      path: 'file:///document/mmproj.gguf',
      use_gpu: false,
      image_min_tokens: 256,
      image_max_tokens: 512,
    });
    expect(releaseMultimodal).toHaveBeenCalledTimes(1);
  });

  it('omits native multimodal image token overrides when they are not provided', async () => {
    const initMultimodal = jest.fn().mockResolvedValue(true);
    const context = createContext({ initMultimodal });

    await expect(initMultimodalOnContext({
      context,
      path: 'file:///document/mmproj.gguf',
      useGpu: true,
    })).resolves.toBe(true);

    expect(initMultimodal).toHaveBeenCalledWith({
      path: 'file:///document/mmproj.gguf',
      use_gpu: true,
    });
  });

  it('rejects unsupported chat roles before calling the native formatter', () => {
    expect(() => normalizeLlamaMessages([
      { role: 'tool' as never, content: 'Nope' },
    ])).toThrow('unsupported role');
  });
});
