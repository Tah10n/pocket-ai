import {
  sanitizeErrorForReport,
  sanitizeErrorReportContext,
  sanitizeErrorReportString,
  sanitizeModelErrorReportContext,
} from '../../src/services/ErrorReportSanitizer';

const UNC_PATH = String.raw`\\server\share\Users\alice\model.gguf`;
const UNC_PATH_WITH_SPACES = String.raw`\\server\shared models\Users\Alice Smith\model file.gguf`;
const UNC_PATH_WITH_SPACES_NO_EXTENSION = String.raw`\\server\shared models\Users\Alice Smith\cache folder`;
const EXTENDED_DRIVE_PATH = String.raw`\\?\C:\Users\alice\model.gguf`;
const EXTENDED_DRIVE_PATH_WITH_SPACES = String.raw`\\?\C:\Users\Alice Smith\model file.gguf`;
const EXTENDED_UNC_PATH = String.raw`\\?\UNC\server\share\folder\file.gguf`;
const EXTENDED_UNC_PATH_WITH_SPACES_NO_EXTENSION = String.raw`\\?\UNC\server\shared models\Users\Alice Smith\cache folder`;

describe('ErrorReportSanitizer', () => {
  it('redacts Windows UNC and extended paths in strings without redacting safe URLs or model ids', () => {
    const value = [
      `standard ${UNC_PATH}`,
      `standard with spaces ${UNC_PATH_WITH_SPACES}`,
      `no extension ${UNC_PATH_WITH_SPACES_NO_EXTENSION}`,
      `extended drive ${EXTENDED_DRIVE_PATH}`,
      `extended drive with spaces ${EXTENDED_DRIVE_PATH_WITH_SPACES}`,
      `extended UNC ${EXTENDED_UNC_PATH}`,
      `extended UNC no extension ${EXTENDED_UNC_PATH_WITH_SPACES_NO_EXTENSION}`,
      'safe URL https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      'safe model author/model-q4',
    ].join(' | ');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('standard [path]');
    expect(sanitized).toContain('standard with spaces [path]');
    expect(sanitized).toContain('no extension [path]');
    expect(sanitized).toContain('extended drive [path]');
    expect(sanitized).toContain('extended drive with spaces [path]');
    expect(sanitized).toContain('extended UNC [path]');
    expect(sanitized).toContain('extended UNC no extension [path]');
    expect(sanitized).toContain('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized).toContain('author/model-q4');
    expect(sanitized).not.toContain('server\\share');
    expect(sanitized).not.toContain('Alice Smith');
    expect(sanitized).not.toContain('model file');
    expect(sanitized).not.toContain('C:\\Users\\alice');
    expect(sanitized).not.toContain('UNC\\server');
  });

  it('redacts picker URIs and broader Android or Unix local paths in strings', () => {
    const value = [
      'content content://media/external/images/media/12',
      'photo ph://ABC/L0/001',
      'sdcard /sdcard/DCIM/private photo.jpg',
      'workspace /workspace/pocket_ai/private/model.gguf',
      'mnt /mnt/media_rw/secret-card/photo.jpg',
      'safe URL https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      'safe model org/model-q4',
    ].join(' | ');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('content [uri]');
    expect(sanitized).toContain('photo [uri]');
    expect(sanitized).toContain('sdcard [path]');
    expect(sanitized).toContain('workspace [path]');
    expect(sanitized).toContain('mnt [path]');
    expect(sanitized).toContain('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized).toContain('org/model-q4');
    expect(sanitized).not.toContain('content://');
    expect(sanitized).not.toContain('ph://');
    expect(sanitized).not.toContain('/sdcard');
    expect(sanitized).not.toContain('/workspace');
    expect(sanitized).not.toContain('/mnt');
  });

  it('redacts UNC paths in error messages, stacks, details, and arrays', () => {
    const error = new Error(`Load failed for ${UNC_PATH} with Bearer raw-token`);
    error.stack = `Error: boom\n    at load (${EXTENDED_DRIVE_PATH}:10:2)\n    at native (${EXTENDED_UNC_PATH})`;
    (error as Error & { details?: Record<string, unknown> }).details = {
      retryPath: UNC_PATH,
      nested: {
        paths: [EXTENDED_DRIVE_PATH, { source: EXTENDED_UNC_PATH }],
      },
      requestUrl: 'https://example.test/model.gguf?access_token=secret&ok=1',
      localPath: UNC_PATH,
      downloadUrl: 'https://example.test/model.gguf?token=secret',
    };

    const report = sanitizeErrorForReport(error, { includeStack: true }) as any;
    const serialized = JSON.stringify(report);

    expect(report.message).toContain('Load failed for [path]');
    expect(report.stack).toContain('[path]');
    expect(report.details.retryPath).toBe('[path]');
    expect(report.details.nested.paths).toEqual(['[path]', { source: '[path]' }]);
    expect(report.details.requestUrl).toBe('https://example.test/model.gguf?access_token=[redacted]&ok=1');
    expect(report.details.localPath).toBeUndefined();
    expect(report.details.downloadUrl).toBeUndefined();
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('raw-token');
    expect(serialized).not.toContain('token=secret');
  });

  it('redacts UNC paths in cyclic-safe contexts while preserving existing context rules', () => {
    const context: Record<string, unknown> = {
      localPath: UNC_PATH,
      downloadUrl: 'https://example.test/model.gguf?token=secret',
      modelId: 'author/model-q4',
      unsafeModelId: EXTENDED_UNC_PATH,
      nested: {
        path: UNC_PATH,
        values: [EXTENDED_DRIVE_PATH, EXTENDED_UNC_PATH],
      },
      publicUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      tokenUrl: 'https://example.test/model.gguf?token=secret&ok=1',
    };
    context.self = context;

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.localPath).toBeUndefined();
    expect(sanitized.downloadUrl).toBeUndefined();
    expect(sanitized.modelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.unsafeModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.nested.path).toBe('[path]');
    expect(sanitized.nested.values).toEqual(['[path]', '[path]']);
    expect(sanitized.publicUrl).toBe('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized.tokenUrl).toBe('https://example.test/model.gguf?token=[redacted]&ok=1');
    expect(sanitized.self).toBe('[Circular]');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('UNC\\server');
  });

  it('redacts sensitive object keys as well as values', () => {
    const context = {
      'file:///private/var/mobile/Containers/Data/chat-attachments/private-passport.jpg': 'copy failed',
      'file:///private/var/mobile/Containers/Data/chat-attachments/second-private.jpg': 'second failure',
      'Prompt: Describe my private passport photo': 'runtime failed',
      'apiKey: sk-live-private': 'api key failed',
      'access_token=secret-token&ok=1': 'token key failed',
      'Authorization: Bearer abc.def.secret': 'authorization failed',
      'secret=first-secret': 'first secret key failed',
      'secret=second-secret': 'second secret key failed',
      nested: {
        [EXTENDED_DRIVE_PATH]: 'windows path key',
        'content://media/external/images/media/12': 'picker key',
        "credential='credential-secret'": 'credential key',
      },
    };

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized['[file-uri]']).toBe('copy failed');
    expect(sanitized['[file-uri]#2']).toBe('second failure');
    expect(sanitized['Prompt: [redacted]']).toBe('runtime failed');
    expect(sanitized['apiKey: [redacted]']).toBe('api key failed');
    expect(sanitized['access_token=[redacted]&ok=1']).toBe('token key failed');
    expect(sanitized['Authorization: [redacted]']).toBe('[redacted]');
    expect(sanitized['secret=[redacted]']).toBe('[redacted]');
    expect(sanitized['secret=[redacted]#2']).toBe('[redacted]');
    expect(sanitized.nested['[path]']).toBe('windows path key');
    expect(sanitized.nested['[uri]']).toBe('picker key');
    expect(sanitized.nested["credential='[redacted]'"]).toBe('[redacted]');
    expect(serialized).not.toContain('private-passport');
    expect(serialized).not.toContain('second-private');
    expect(serialized).not.toContain('Describe my private passport photo');
    expect(serialized).not.toContain('sk-live-private');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('abc.def.secret');
    expect(serialized).not.toContain('first-secret');
    expect(serialized).not.toContain('second-secret');
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('C:\\Users\\alice');
    expect(serialized).not.toContain('content://');
  });

  it('hashes modelId and projectorId diagnostic variants even when ids look public', () => {
    const context = {
      activeModelId: 'org/model-q4',
      readinessModelId: 'C:\\Users\\alice\\models\\private-model.gguf',
      expectedModelId: 'private/local-model?token=secret',
      selectedProjectorId: '/private/var/mobile/Containers/Data/projectors/private.mmproj',
      activeProjectorId: 'org/projector-mmproj',
      expectedProjectorId: String.raw`\\server\share\Users\alice\private-projector.mmproj`,
      nested: {
        readinessProjectorId: 'file:///private/var/mobile/Containers/Data/private-projector.mmproj',
      },
    };

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.activeModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.activeProjectorId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.readinessModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.expectedModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.selectedProjectorId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.expectedProjectorId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(sanitized.nested.readinessProjectorId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(serialized).not.toContain('C:\\Users\\alice');
    expect(serialized).not.toContain('org/model-q4');
    expect(serialized).not.toContain('org/projector-mmproj');
    expect(serialized).not.toContain('private/local-model');
    expect(serialized).not.toContain('/private/var/mobile');
    expect(serialized).not.toContain('private-projector');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('server\\share');
    expect(serialized).not.toContain('token=secret');
  });

  it('exports only safe model context fields and hashes model identifiers', () => {
    const sanitized = sanitizeModelErrorReportContext({
      id: 'private-author/private-model-q4',
      name: 'Private Local Model',
      author: 'Private Author',
      localPath: 'file:///private/var/mobile/Containers/Data/private-model.gguf',
      downloadUrl: 'https://example.test/model.gguf?token=secret',
      size: 123,
      sizeBytes: 456n,
      lifecycleStatus: 'downloaded',
      accessState: 'public',
      pathCategory: 'model_storage',
      artifactKind: 'model',
      nested: {
        prompt: 'describe my private image',
      },
      gguf: {
        architecture: 'llama',
        sizeLabel: 'Q4_K_M',
        totalBytes: 456,
        modelName: 'Private Base Model',
        tokenizerPath: '/private/var/mobile/tokenizer.model',
      },
    }) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toEqual(expect.objectContaining({
      idHash: expect.stringMatching(/^hash:[a-z0-9]+$/),
      nameHash: expect.stringMatching(/^hash:[a-z0-9]+$/),
      authorHash: expect.stringMatching(/^hash:[a-z0-9]+$/),
      size: 123,
      sizeBytes: '456',
      lifecycleStatus: 'downloaded',
      accessState: 'public',
      pathCategory: 'model_storage',
      artifactKind: 'model',
      gguf: {
        architecture: 'llama',
        sizeLabel: 'Q4_K_M',
        totalBytes: 456,
      },
    }));
    expect(sanitized.id).toBeUndefined();
    expect(sanitized.name).toBeUndefined();
    expect(sanitized.author).toBeUndefined();
    expect(sanitized.localPath).toBeUndefined();
    expect(sanitized.downloadUrl).toBeUndefined();
    expect(sanitized.nested).toBeUndefined();
    expect(serialized).not.toContain('private-author');
    expect(serialized).not.toContain('private-model-q4');
    expect(serialized).not.toContain('Private Local Model');
    expect(serialized).not.toContain('Private Author');
    expect(serialized).not.toContain('Private Base Model');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('/private/var/mobile');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('describe my private image');
  });

  it('drops URI-like object keys unless they contain safe public HTTPS URLs', () => {
    const context = {
      uri: 'content://media/external/images/media/12',
      localUri: 'file:///sdcard/Download/private-model.gguf',
      pickerUri: 'ph://ABC/L0/001',
      previewUri: 'content://media/external/images/media/13',
      thumbnailUri: 'content://media/external/images/media/14',
      publicUri: 'https://huggingface.co/org/model/resolve/main/model.gguf?ok=1',
      requestUri: 'https://example.test/model.gguf?token=secret&ok=1',
      path: '/workspace/private/file.gguf',
      modelId: 'org/model-q4',
    };

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.uri).toBeUndefined();
    expect(sanitized.localUri).toBeUndefined();
    expect(sanitized.pickerUri).toBeUndefined();
    expect(sanitized.previewUri).toBeUndefined();
    expect(sanitized.thumbnailUri).toBeUndefined();
    expect(sanitized.publicUri).toBe('https://huggingface.co/org/model/resolve/main/model.gguf?ok=1');
    expect(sanitized.requestUri).toBe('https://example.test/model.gguf?token=[redacted]&ok=1');
    expect(sanitized.path).toBe('[path]');
    expect(sanitized.modelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(serialized).not.toContain('content://');
    expect(serialized).not.toContain('ph://');
    expect(serialized).not.toContain('/sdcard');
    expect(serialized).not.toContain('/workspace/private');
    expect(serialized).not.toContain('token=secret');
  });

  it('redacts prompts and image payloads from report strings and details', () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABPRIVATEPAYLOAD';
    const jpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAADPRIVATEPAYLOADPRIVATEPAYLOAD';
    const dataUri = `data:image/png;base64,${pngBase64}`;
    const prompt = 'Describe my private photo and address';
    const error = new Error(
      `content uri content://media/external/images/media/12 gallery ph://ABC/L0/001 data ${dataUri}\nPrompt: ${prompt}\nsecond private prompt line`,
    );
    (error as Error & { details?: Record<string, unknown> }).details = {
      prompt,
      imageData: dataUri,
      dataUri,
      base64: pngBase64,
      bytes: jpegBase64,
      imageBytes: jpegBase64,
      note: `normal note kept; base64: ${pngBase64}; path ${EXTENDED_DRIVE_PATH}; gallery gallery://local/private-asset`,
      safeNote: 'normal base64 mention without payload is kept',
      sizeBytes: 123,
      nested: {
        safe: true,
        userPrompt: prompt,
        contentUri: 'content://media/external/images/media/13',
      },
    };

    const report = sanitizeErrorForReport(error, { includeStack: true }) as any;
    const serialized = JSON.stringify(report);

    expect(report.message).toContain('Prompt: [redacted]');
    expect(report.message).toContain('[uri]');
    expect(report.message).toContain('[redacted-payload]');
    expect(report.message).not.toContain('second private prompt line');
    expect(report.details.prompt).toBeUndefined();
    expect(report.details.imageData).toBeUndefined();
    expect(report.details.dataUri).toBeUndefined();
    expect(report.details.base64).toBeUndefined();
    expect(report.details.bytes).toBeUndefined();
    expect(report.details.imageBytes).toBeUndefined();
    expect(report.details.sizeBytes).toBe(123);
    expect(report.details.safeNote).toBe('normal base64 mention without payload is kept');
    expect(report.details.note).toContain('normal note kept');
    expect(report.details.note).toContain('[redacted-payload]');
    expect(report.details.note).toContain('[path]');
    expect(report.details.note).toContain('[uri]');
    expect(report.details.nested.safe).toBe(true);
    expect(report.details.nested.userPrompt).toBeUndefined();
    expect(report.details.nested.contentUri).toBeUndefined();
    expect(serialized).not.toContain(prompt);
    expect(serialized).not.toContain('second private prompt line');
    expect(serialized).not.toContain('content://');
    expect(serialized).not.toContain('ph://');
    expect(serialized).not.toContain('gallery://');
    expect(serialized).not.toContain('data:image/');
    expect(serialized).not.toContain(pngBase64);
    expect(serialized).not.toContain(jpegBase64);
    expect(serialized).not.toContain('C:\\Users\\alice');
  });

  it('redacts multiline labeled prompt payloads while preserving stack boundaries', () => {
    const value = [
      'Prompt: private first line',
      'private second line',
      '    at loadModel (engine.ts:10:2)',
      'systemPrompt: hidden system instruction',
      'hidden system continuation',
      'Error: visible failure',
      'userPrompt: hidden user text',
      'hidden user continuation',
      'code: E_TEST',
      'status: private prompt status',
      'model: private/local-model',
      'Caused by: visible cause',
      'prompts=hidden prompt array item',
      'hidden prompt array continuation',
      'Error: visible prompts failure',
    ].join('\n');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('Prompt: [redacted]\n    at loadModel (engine.ts:10:2)');
    expect(sanitized).toContain('systemPrompt: [redacted]\nError: visible failure');
    expect(sanitized).toContain('userPrompt: [redacted]\nCaused by: visible cause');
    expect(sanitized).toContain('prompts=[redacted]\nError: visible prompts failure');
    expect(sanitized).not.toContain('private first line');
    expect(sanitized).not.toContain('private second line');
    expect(sanitized).not.toContain('hidden system instruction');
    expect(sanitized).not.toContain('hidden system continuation');
    expect(sanitized).not.toContain('hidden user text');
    expect(sanitized).not.toContain('hidden user continuation');
    expect(sanitized).not.toContain('E_TEST');
    expect(sanitized).not.toContain('private prompt status');
    expect(sanitized).not.toContain('private/local-model');
    expect(sanitized).not.toContain('hidden prompt array item');
    expect(sanitized).not.toContain('hidden prompt array continuation');
  });

  it('redacts prompt-like quoted payloads in runtime error text', () => {
    const longPrompt = `${'long private text '.repeat(140)}final private address`;
    const value = [
      'Native completion failed while processing prompt "Describe my private photo and address"',
      'runner rejected user input "Tell me where I live" after image file:///private/mobile/photo.jpg',
      'raw message \'This is my private address\' caused failure',
      'message content "passport number and private notes" was too long',
      `Native completion failed while processing prompt "${longPrompt}"`,
      'Native completion failed while processing prompt "truncated private prompt line\n    at nativeRuntime (engine.ts:10:2)',
    ].join(' | ');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('processing prompt "[redacted]"');
    expect(sanitized).toContain('user input "[redacted]"');
    expect(sanitized).toContain('raw message \'[redacted]\'');
    expect(sanitized).toContain('message content "[redacted]"');
    expect(sanitized).toContain('processing prompt "[redacted]"');
    expect(sanitized).toContain('processing prompt "[redacted]\n    at nativeRuntime (engine.ts:10:2)');
    expect(sanitized).toContain('[file-uri]');
    expect(sanitized).not.toContain('Describe my private photo');
    expect(sanitized).not.toContain('Tell me where I live');
    expect(sanitized).not.toContain('This is my private address');
    expect(sanitized).not.toContain('passport number');
    expect(sanitized).not.toContain('long private text');
    expect(sanitized).not.toContain('final private address');
    expect(sanitized).not.toContain('truncated private prompt line');
    expect(sanitized).not.toContain('file:///private/mobile');
  });

  it('redacts JSON-style quoted prompt fields embedded in strings', () => {
    const value = [
      'native details {"prompt":"Describe my private home","ok":true}',
      "runner payload {'userPrompt':'Hidden user instruction','count':1}",
      'truncated payload {"systemPrompt":"Hidden system instruction,"ok":false}',
      'quoted prompt prose should still redact prompt "private prose"',
    ].join(' | ');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('{"prompt":"[redacted]","ok":true}');
    expect(sanitized).toContain("{'userPrompt':'[redacted]','count':1}");
    expect(sanitized).toContain('{"systemPrompt":"[redacted]');
    expect(sanitized).toContain('prompt "[redacted]"');
    expect(sanitized).not.toContain('Describe my private home');
    expect(sanitized).not.toContain('Hidden user instruction');
    expect(sanitized).not.toContain('Hidden system instruction');
    expect(sanitized).not.toContain('private prose');
  });

  it('redacts chat message content and multimodal text parts from structured diagnostics', () => {
    const context = {
      messages: [
        { role: 'system', content: 'Private system instruction' },
        { role: 'user', content: 'Describe my private photo' },
      ],
      runtimeMessage: {
        role: 'user',
        content: [
          { type: 'text', text: 'Hidden multimodal user text' },
          { type: 'image_url', image_url: { url: 'file:///private/var/mobile/photo.jpg' } },
        ],
      },
      looseTextPart: {
        type: 'text',
        text: 'Loose private text part',
      },
      safeMetadata: {
        role: 'user',
        tokenCount: 42,
      },
    };

    const sanitized = sanitizeErrorReportContext(context) as any;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.messages).toBeUndefined();
    expect(sanitized.runtimeMessage.content).toBe('[redacted]');
    expect(sanitized.looseTextPart.text).toBe('[redacted]');
    expect(sanitized.safeMetadata.tokenCount).toBe(42);
    expect(serialized).not.toContain('Private system instruction');
    expect(serialized).not.toContain('Describe my private photo');
    expect(serialized).not.toContain('Hidden multimodal user text');
    expect(serialized).not.toContain('Loose private text part');
    expect(serialized).not.toContain('file:///private/var/mobile');
  });

  it('redacts serialized chat payloads from error strings and user notes', () => {
    const payload = JSON.stringify({
      requestId: 'safe-request-id',
      messages: [
        { role: 'user', content: 'Serialized private prompt' },
      ],
      latestMessage: {
        role: 'user',
        content: [
          { type: 'text', text: 'Serialized text part secret' },
          { type: 'image_url', image_url: { url: 'file:///private/mobile/image.jpg' } },
        ],
      },
    });
    const embeddedPayload = `native details {"messages":[{"role":"user","content":"Embedded private prompt"}],"parts":[{"type":"text","text":"Embedded text part secret"}]}`;

    const sanitizedPayload = sanitizeErrorReportString(payload);
    const sanitizedEmbeddedPayload = sanitizeErrorReportString(embeddedPayload);
    const serialized = JSON.stringify({ sanitizedPayload, sanitizedEmbeddedPayload });

    expect(sanitizedPayload).toContain('safe-request-id');
    expect(sanitizedPayload).toContain('[redacted]');
    expect(sanitizedEmbeddedPayload).toContain('[redacted]');
    expect(serialized).not.toContain('Serialized private prompt');
    expect(serialized).not.toContain('Serialized text part secret');
    expect(serialized).not.toContain('Embedded private prompt');
    expect(serialized).not.toContain('Embedded text part secret');
    expect(serialized).not.toContain('file:///private/mobile');
  });

  it('redacts unterminated JSON-style prompt field tails through stack boundaries', () => {
    const value = [
      'native details {"prompt":"home address, phone 555-1234, private note',
      '    at nativeRuntime (engine.ts:10:2)',
      'Error: visible failure',
    ].join('\n');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('{"prompt":"[redacted]\n    at nativeRuntime (engine.ts:10:2)');
    expect(sanitized).toContain('Error: visible failure');
    expect(sanitized).not.toContain('home address');
    expect(sanitized).not.toContain('phone 555-1234');
    expect(sanitized).not.toContain('private note');
  });

  it('does not stop prompt redaction at inline punctuation or metadata-like tokens', () => {
    const value = [
      'Prompt: private prompt; code: E_SECRET | model: /Users/alice/private-model.gguf',
      '    at invokeVision (engine.ts:10:2)',
      'status: visible status metadata',
      'userPrompt=hidden user text | model: private/local ; code: E_USER_SECRET',
      'Error: visible failure',
    ].join('\n');

    const sanitized = sanitizeErrorReportString(value);

    expect(sanitized).toContain('Prompt: [redacted]\n    at invokeVision (engine.ts:10:2)');
    expect(sanitized).toContain('status: visible status metadata');
    expect(sanitized).toContain('userPrompt=[redacted]\nError: visible failure');
    expect(sanitized).not.toContain('private prompt');
    expect(sanitized).not.toContain('E_SECRET');
    expect(sanitized).not.toContain('private-model');
    expect(sanitized).not.toContain('hidden user text');
    expect(sanitized).not.toContain('private/local');
    expect(sanitized).not.toContain('E_USER_SECRET');
  });
});
