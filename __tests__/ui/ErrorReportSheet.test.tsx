import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

jest.mock('@/services/AppError', () => ({
  toAppError: (error: unknown) => ({
    code: 'E_TEST',
    message: error instanceof Error ? error.message : 'Something went wrong',
    details: {
      reason: 'unit-test',
      nested: { ok: true },
      ...((error as { reportDetails?: Record<string, unknown> } | null)?.reportDetails ?? {}),
    },
  }),
}));

jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
  supportedAbis: jest.fn().mockResolvedValue(['arm64-v8a']),
  isEmulator: jest.fn().mockResolvedValue(false),
  getModel: jest.fn(() => 'Pixel 9'),
  getBuildNumber: jest.fn(() => '123'),
  getVersion: jest.fn(() => '1.2.3'),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';

const mockFileDelete = jest.fn();

function parseLastClipboardJson(): any {
  const calls = (Clipboard.setStringAsync as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const json = calls[calls.length - 1][0];
  expect(typeof json).toBe('string');
  return JSON.parse(json);
}

function parseLastShareMessageJson(): any {
  const calls = (Share.share as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const payload = calls[calls.length - 1][0];
  expect(typeof payload.message).toBe('string');
  return JSON.parse(payload.message);
}

describe('ErrorReportSheet', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    jest.clearAllMocks();
    mockFileDelete.mockReset();
    mockFileDelete.mockResolvedValue(undefined);
    (File as any).prototype.delete = mockFileDelete;

    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hides optional include toggles when context is missing', async () => {
    const { queryByTestId } = render(
      <ErrorReportSheet
        visible
        scope="test"
        error={new Error('boom')}
        onClose={jest.fn()}
      />,
    );

    // Settle the device info effect to avoid act warnings.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryByTestId('include-model-on')).toBeNull();
    expect(queryByTestId('include-engine-on')).toBeNull();
    expect(queryByTestId('include-options-on')).toBeNull();
    // diagnostics toggle is hidden when there are no details; our mocked toAppError includes details,
    // so it should be shown.
    expect(queryByTestId('include-diagnostics-on')).not.toBeNull();
  });

  it('closes through the sheet backdrop', async () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ErrorReportSheet
        visible
        scope="test"
        error={new Error('boom')}
        onClose={onClose}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByTestId('error-report-sheet')).toBeTruthy();
    fireEvent.press(getByTestId('error-report-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('builds payload based on toggles and additional info; copy success/failure alerts', async () => {
    const error = new Error('boom');
    error.stack = 'STACKTRACE';

    const { getByText, getByTestId, getByPlaceholderText } = render(
      <ErrorReportSheet
        visible
        scope="model-load"
        error={error}
        context={{
          model: { id: 'author/model-q4', sizeBytes: 123n },
          engine: { backendMode: 'gpu', devices: ['GPU0'] },
          options: { threads: 4 },
          extra: { note: 'extra' },
        } as any}
        onClose={jest.fn()}
      />,
    );

    // Wait for device info effect to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.changeText(
      getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
      '  hello  ',
    );

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payloadA = parseLastClipboardJson();
    expect(payloadA.scope).toBe('model-load');
    expect(payloadA.additionalInfo).toBe('hello');
    expect(payloadA.model).toEqual({
      idHash: expect.stringMatching(/^hash:[a-z0-9]+$/),
      sizeBytes: '123',
    });
    expect(JSON.stringify(payloadA.model)).not.toContain('author/model-q4');
    expect(payloadA.engine).toEqual({ backendMode: 'gpu', devices: ['GPU0'] });
    expect(payloadA.options).toEqual({ threads: 4 });
    expect(payloadA.extra).toEqual({ note: 'extra' });
    expect(payloadA.diagnostics).toEqual(expect.any(Object));
    expect(payloadA.device).toBeUndefined();
    expect(JSON.stringify(payloadA)).not.toContain('Pixel 9');
    expect(payloadA.error.stack).toBe('STACKTRACE');

    // Device fingerprinting fields require explicit opt-in.
    fireEvent.press(getByTestId('include-device-on'));

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payloadWithDevice = parseLastClipboardJson();
    expect(payloadWithDevice.device).toEqual(
      expect.objectContaining({
        deviceModel: 'Pixel 9',
        cpuArch: ['arm64-v8a'],
      }),
    );

    // Toggle off model, device, and stack trace.
    fireEvent.press(getByTestId('include-model-off'));
    fireEvent.press(getByTestId('include-device-off'));
    fireEvent.press(getByTestId('include-stack-off'));

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payloadB = parseLastClipboardJson();
    expect(payloadB.model).toBeUndefined();
    expect(payloadB.engine).toBeDefined();
    expect(payloadB.device).toBeUndefined();
    expect(payloadB.error.stack).toBeUndefined();

    // Copy failure shows alert.
    (Clipboard.setStringAsync as jest.Mock).mockRejectedValueOnce(new Error('copy failed'));
    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'models.errorReport.failedTitle',
      'models.errorReport.copyFailedMessage',
    );
  });

  it('exports sanitized multimodal engine diagnostics selected for support reports', async () => {
    const { getByText } = render(
      <ErrorReportSheet
        visible
        scope="vision-readiness"
        error={new Error('vision failed for file:///private/var/mobile/projector.gguf')}
        context={{
          engine: {
            status: 'error',
            activeModelId: 'private/local-model?token=secret',
            diagnostics: {
              multimodal: {
                visionCapability: 'vision_capable',
                projectorPresence: 'downloaded',
                projectorPathCategory: 'models',
                projectorSize: 123_456,
                readinessStatus: 'failed',
                failureReason: 'runtime:initialization_failed:path_redacted',
                attachmentCount: 2,
                attachmentTotalBytes: 456_789,
              },
              localPath: 'file:///private/var/mobile/Containers/Data/model.gguf',
            },
          },
        } as any}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payload = parseLastClipboardJson();
    const serialized = JSON.stringify(payload);
    expect(payload.engine.activeModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(payload.engine.diagnostics.multimodal).toEqual({
      visionCapability: 'vision_capable',
      projectorPresence: 'downloaded',
      projectorPathCategory: 'models',
      projectorSize: 123_456,
      readinessStatus: 'failed',
      failureReason: 'runtime:initialization_failed:path_redacted',
      attachmentCount: 2,
      attachmentTotalBytes: 456_789,
    });
    expect(payload.engine.diagnostics.localPath).toBeUndefined();
    expect(serialized).not.toContain('private/local-model');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('/private/var/mobile');
    expect(serialized).not.toContain('token=secret');
  });

  it('sanitizes sensitive paths, URLs, tokens, and diagnostics before copy/export', async () => {
    const error = new Error(
      'Load failed for file:///private/var/mobile/Containers/Data/model.gguf with Bearer abc.def',
    );
    error.stack = 'Error: boom\n    at load (C:\\Users\\alice\\dev\\pocket_ai\\specs\\secret.ts:10:2)\n    at native (/private/var/mobile/Containers/Data/model.gguf?token=secret)';
    (error as any).reportDetails = {
      localPath: 'file:///private/var/mobile/Containers/Data/model.gguf',
      downloadUrl: 'https://example.test/model.gguf?token=secret',
      pathCategory: 'model_storage',
      status: 403,
    };

    const { getByText, getByPlaceholderText } = render(
      <ErrorReportSheet
        visible
        scope="model-load"
        error={error}
        context={{
          model: {
            id: 'author/model-q4',
            localPath: 'file:///private/var/mobile/Containers/Data/model.gguf',
            downloadUrl: 'https://example.test/model.gguf?access_token=secret&safe=1',
            pathCategory: 'model_storage',
            artifactKind: 'model',
            sizeBytes: 123,
            nested: {
              retryPath: 'C:\\Users\\alice\\Downloads\\model.gguf',
              auth: 'Bearer native-token',
            },
          },
          extra: {
            url: 'https://example.test/model.gguf?token=secret&ok=1',
            unsafeModelId: 'C:\\Users\\alice\\models\\private.gguf',
          },
        } as any}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.changeText(
      getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
      'User note kept as typed',
    );

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payload = parseLastClipboardJson();
    const serialized = JSON.stringify(payload);

    expect(payload.additionalInfo).toBe('User note kept as typed');
    expect(payload.error.message).toContain('[file-uri]');
    expect(payload.error.message).toContain('Bearer [redacted]');
    expect(payload.error.stack).toContain('[path]');
    expect(payload.model).toEqual(expect.objectContaining({
      idHash: expect.stringMatching(/^hash:[a-z0-9]+$/),
      pathCategory: 'model_storage',
      artifactKind: 'model',
      sizeBytes: 123,
    }));
    expect(payload.model.id).toBeUndefined();
    expect(payload.model.localPath).toBeUndefined();
    expect(payload.model.downloadUrl).toBeUndefined();
    expect(payload.model.nested).toBeUndefined();
    expect(payload.extra.url).toBe('https://example.test/model.gguf?token=[redacted]&ok=1');
    expect(payload.diagnostics).toEqual(expect.objectContaining({
      pathCategory: 'model_storage',
      status: 403,
    }));
    expect(payload.diagnostics.localPath).toBeUndefined();
    expect(payload.diagnostics.downloadUrl).toBeUndefined();

    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('C:\\Users\\alice');
    expect(serialized).not.toContain('/private/var/mobile');
    expect(serialized).not.toContain('abc.def');
    expect(serialized).not.toContain('native-token');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('access_token=secret');
    expect(serialized).not.toContain('author/model-q4');
  });

  it('sanitizes sensitive diagnostic keys in the preview and copied report', async () => {
    const error = new Error('key leak failed');
    (error as any).reportDetails = {
      'file:///private/var/mobile/Containers/Data/chat-attachments/private-passport.jpg': 'copy failed',
      'Prompt: Describe my private passport photo': 'runtime failed',
      'apiKey: sk-live-private': 'api key failed',
      'Authorization: Bearer abc.def.secret': 'authorization failed',
    };

    const { getByText, toJSON } = render(
      <ErrorReportSheet
        visible
        scope="key-leak"
        error={error}
        context={{
          extra: {
            'content://media/external/images/media/12': 'picker key',
            'access_token=secret-token&ok=1': 'token key failed',
          },
        } as any}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedPreview = JSON.stringify(toJSON());
    expect(renderedPreview).toContain('[file-uri]');
    expect(renderedPreview).toContain('Prompt: [redacted]');
    expect(renderedPreview).toContain('apiKey: [redacted]');
    expect(renderedPreview).toContain('Authorization: [redacted]');
    expect(renderedPreview).toContain('[uri]');
    expect(renderedPreview).toContain('access_token=[redacted]&ok=1');
    expect(renderedPreview).not.toContain('private-passport');
    expect(renderedPreview).not.toContain('Describe my private passport photo');
    expect(renderedPreview).not.toContain('sk-live-private');
    expect(renderedPreview).not.toContain('abc.def.secret');
    expect(renderedPreview).not.toContain('secret-token');
    expect(renderedPreview).not.toContain('content://');

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payload = parseLastClipboardJson();
    const serialized = JSON.stringify(payload);
    expect(payload.diagnostics['[file-uri]']).toBe('copy failed');
    expect(payload.diagnostics['Prompt: [redacted]']).toBe('runtime failed');
    expect(payload.diagnostics['apiKey: [redacted]']).toBe('api key failed');
    expect(payload.diagnostics['Authorization: [redacted]']).toBe('[redacted]');
    expect(payload.extra['[uri]']).toBe('picker key');
    expect(payload.extra['access_token=[redacted]&ok=1']).toBe('token key failed');
    expect(serialized).not.toContain('private-passport');
    expect(serialized).not.toContain('Describe my private passport photo');
    expect(serialized).not.toContain('sk-live-private');
    expect(serialized).not.toContain('abc.def.secret');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('content://');
  });

  it('renders a bounded summary preview while copy exports the complete sanitized report', async () => {
    const largeSafeDiagnostic = 'safe-diagnostic-value-'.repeat(160);
    const error = new Error('preview boom');
    (error as any).reportDetails = {
      safeLargeDiagnostic: largeSafeDiagnostic,
      activeModelId: 'C:\\Users\\alice\\models\\private-model.gguf',
      selectedProjectorId: '/private/var/mobile/Containers/Data/projectors/private.mmproj',
    };

    const { getByText, toJSON } = render(
      <ErrorReportSheet
        visible
        scope="preview-test"
        error={error}
        context={{
          extra: {
            safeLargeContext: largeSafeDiagnostic,
            readinessModelId: 'private/local-model?token=secret',
          },
        } as any}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const renderedPreview = JSON.stringify(toJSON());
    expect(renderedPreview).toContain('includedSections');
    expect(renderedPreview).toContain('sectionKeys');
    expect(renderedPreview).not.toContain(largeSafeDiagnostic);
    expect(renderedPreview).not.toContain('private-model.gguf');
    expect(renderedPreview).not.toContain('/private/var/mobile');
    expect(renderedPreview).not.toContain('private/local-model');

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payload = parseLastClipboardJson();
    const serialized = JSON.stringify(payload);
    expect(payload.diagnostics.safeLargeDiagnostic).toBe(largeSafeDiagnostic);
    expect(payload.extra.safeLargeContext).toBe(largeSafeDiagnostic);
    expect(payload.diagnostics.activeModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(payload.diagnostics.selectedProjectorId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(payload.extra.readinessModelId).toEqual(expect.stringMatching(/^hash:[a-z0-9]+$/));
    expect(serialized).not.toContain('private-model.gguf');
    expect(serialized).not.toContain('/private/var/mobile');
    expect(serialized).not.toContain('private/local-model');
    expect(serialized).not.toContain('token=secret');
  });

  it('sanitizes additional info before truncating the report preview', async () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABPRIVATEPAYLOAD';
    const prefix = 'safe preview context '.repeat(10);
    const { getByPlaceholderText, getByText } = render(
      <ErrorReportSheet
        visible
        scope="preview-media"
        error={new Error('preview media failed')}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.changeText(
      getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
      `${prefix}base64: ${pngBase64}`,
    );

    const previewText = getByText(/"additionalInfoPreview"/).props.children;
    expect(previewText).toContain('[redacted-payload]');
    expect(previewText).not.toContain('iVBORw0KGgo');
    expect(previewText).not.toContain('PRIVATEPAYLOAD');
  });

  it('keeps additional info preview bounded while copy sanitizes the full note', async () => {
    const tailPrompt = 'Describe my private passport photo';
    const longSafePrefix = 'safe diagnostic line\n'.repeat(400);
    const { getByPlaceholderText, getByText } = render(
      <ErrorReportSheet
        visible
        scope="bounded-additional-info"
        error={new Error('preview bounded')}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.changeText(
      getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
      `${longSafePrefix}Prompt: ${tailPrompt}`,
    );

    const previewText = getByText(/"additionalInfoPreview"/).props.children;
    expect(previewText).not.toContain(tailPrompt);

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const payload = parseLastClipboardJson();
    expect(payload.additionalInfo).toContain('Prompt: [redacted]');
    expect(JSON.stringify(payload)).not.toContain(tailPrompt);
  });

  it('uses localized copy when report preview serialization falls back', async () => {
    const { getByPlaceholderText, getByText } = render(
      <ErrorReportSheet
        visible
        scope="preview-serialization"
        error={new Error('preview serialization failed')}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const stringifySpy = jest.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('preview stringify failed');
    });

    try {
      fireEvent.changeText(
        getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
        'trigger preview recompute',
      );

      const previewText = getByText(/models\.errorReport\.previewSerializeFailed/).props.children;
      expect(previewText).toContain('models.errorReport.previewSerializeFailed');
      expect(previewText).not.toContain('Failed to serialize report preview');
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('sanitizes additional info and diagnostics media payloads before copy and share fallback', async () => {
    const prompt = 'Describe my private passport photo';
    const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAADPRIVATEPAYLOADPRIVATEPAYLOAD';
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABPRIVATEPAYLOAD';
    const error = new Error('media failed');
    (error as any).reportDetails = {
      prompt,
      localPath: 'file:///private/var/mobile/Containers/Data/private.jpg',
      contentUri: 'content://media/external/images/media/12',
      galleryUri: 'ph://ABC/L0/001',
      dataUri,
      base64: pngBase64,
      imageData: dataUri,
      bytes: pngBase64,
      note: `Prompt: ${prompt}\npath C:\\Users\\alice\\Pictures\\private.jpg\ncontent://media/external/images/media/13\ngallery://local/private-asset\nbase64: ${pngBase64}`,
      sizeBytes: 456,
    };

    const { getByText, getByPlaceholderText } = render(
      <ErrorReportSheet
        visible
        scope="media-load"
        error={error}
        onClose={jest.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.changeText(
      getByPlaceholderText('models.errorReport.additionalInfoPlaceholder'),
      [
        'normal note kept',
        'path C:\\Users\\alice\\Pictures\\private.jpg',
        'content content://media/external/images/media/14',
        'gallery ph://XYZ/L0/002',
        `data ${dataUri}`,
        `base64: ${pngBase64}`,
        `Prompt: ${prompt}`,
        'second private prompt line',
      ].join('\n'),
    );

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.copy'));
      await Promise.resolve();
    });

    const copiedPayload = parseLastClipboardJson();
    const copiedSerialized = JSON.stringify(copiedPayload);

    expect(copiedPayload.additionalInfo).toContain('normal note kept');
    expect(copiedPayload.additionalInfo).toContain('Prompt: [redacted]');
    expect(copiedPayload.additionalInfo).toContain('[path]');
    expect(copiedPayload.additionalInfo).toContain('[uri]');
    expect(copiedPayload.additionalInfo).toContain('[redacted-payload]');
    expect(copiedPayload.additionalInfo).not.toContain('second private prompt line');
    expect(copiedPayload.diagnostics.prompt).toBeUndefined();
    expect(copiedPayload.diagnostics.localPath).toBeUndefined();
    expect(copiedPayload.diagnostics.contentUri).toBeUndefined();
    expect(copiedPayload.diagnostics.galleryUri).toBeUndefined();
    expect(copiedPayload.diagnostics.dataUri).toBeUndefined();
    expect(copiedPayload.diagnostics.base64).toBeUndefined();
    expect(copiedPayload.diagnostics.imageData).toBeUndefined();
    expect(copiedPayload.diagnostics.bytes).toBeUndefined();
    expect(copiedPayload.diagnostics.sizeBytes).toBe(456);

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.share'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    });

    const sharedPayload = parseLastShareMessageJson();
    expect(sharedPayload.additionalInfo).toBe(copiedPayload.additionalInfo);

    for (const serialized of [copiedSerialized, JSON.stringify(sharedPayload)]) {
      expect(serialized).not.toContain(prompt);
      expect(serialized).not.toContain('second private prompt line');
      expect(serialized).not.toContain('file://');
      expect(serialized).not.toContain('C:\\Users\\alice');
      expect(serialized).not.toContain('/private/var/mobile');
      expect(serialized).not.toContain('content://');
      expect(serialized).not.toContain('ph://');
      expect(serialized).not.toContain('gallery://');
      expect(serialized).not.toContain('data:image/');
      expect(serialized).not.toContain(pngBase64);
      expect(serialized).not.toContain('PRIVATEPAYLOAD');
    }
  });

  it('shares via expo-sharing, cleans up the cache file after a grace period, and otherwise falls back to Share API', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(true);

    const { getByText, rerender } = render(
      <ErrorReportSheet visible scope="x" error={new Error('boom')} onClose={jest.fn()} />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.share'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Sharing.shareAsync).toHaveBeenCalled();
    });
    expect(mockFileDelete).not.toHaveBeenCalled();
    expect(Share.share).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1_000);
      await Promise.resolve();
    });

    expect(mockFileDelete).toHaveBeenCalledTimes(1);

    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(false);
    rerender(<ErrorReportSheet visible scope="x" error={new Error('boom')} onClose={jest.fn()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.share'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    });
    expect(mockFileDelete).toHaveBeenCalledTimes(1);
  });

  it('deletes the expo-sharing temp report and falls back when native sharing fails', async () => {
    (Sharing.isAvailableAsync as jest.Mock).mockResolvedValueOnce(true);
    (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error('native share failed'));
    mockFileDelete.mockRejectedValueOnce(new Error('cleanup failed'));

    const { getByText } = render(
      <ErrorReportSheet visible scope="x" error={new Error('boom')} onClose={jest.fn()} />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.press(getByText('models.errorReport.share'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockFileDelete).toHaveBeenCalledTimes(1);
      expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    });
    expect(Alert.alert).not.toHaveBeenCalledWith(
      'models.errorReport.failedTitle',
      'models.errorReport.shareFailedMessage',
    );
  });
});
