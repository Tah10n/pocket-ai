import {
  redactPathLikeValues,
  sanitizeMultimodalFailureCategory,
  sanitizeMultimodalFailureReason,
} from '../../src/utils/multimodalFailureReason';

describe('multimodalFailureReason', () => {
  it.each([
    [
      'Native init failed for C:\\Users\\tester\\Project for Client',
      'Native init failed for [path]',
    ],
    [
      'Native init failed at file:///private/mobile/Project for Client',
      'Native init failed at [path]',
    ],
    [
      'Missing /private/mobile/Project for Client',
      'Missing [path]',
    ],
  ])('redacts extensionless path tails with boundary words: %s', (message, expected) => {
    const sanitized = sanitizeMultimodalFailureReason(message);

    expect(sanitized).toBe(expected);
    expect(sanitized).not.toContain('Project for Client');
    expect(sanitized).not.toContain('C:\\Users');
    expect(sanitized).not.toContain('/private/mobile');
  });

  it('preserves prose after extensionful paths while redacting spaced private segments', () => {
    expect(sanitizeMultimodalFailureReason(
      'Native init failed for file:///private/mobile/Project for Client/mmproj file.gguf after retry',
    )).toBe('Native init failed for [path] after retry');
  });

  it('preserves retry context after extensionless paths without leaking boundary-word components', () => {
    const sanitized = sanitizeMultimodalFailureReason(
      'Native init failed for file:///private/mobile/Project for Client after retry',
    );

    expect(sanitized).toBe('Native init failed for [path] after retry');
    expect(sanitized).not.toContain('Project for Client');
  });

  it('leaves non-path failure reasons unchanged', () => {
    expect(redactPathLikeValues('Native init failed after retry')).toBe('Native init failed after retry');
  });

  it('keeps the memory signal when allocation failures mention prompt processing', () => {
    expect(sanitizeMultimodalFailureCategory('llama.cpp OOM while evaluating prompt tokens')).toBe(
      'runtime:memory_error:completion_failed',
    );
  });

  it('ignores retry and routing keywords inside quoted prompt payloads', () => {
    expect(sanitizeMultimodalFailureCategory(
      'llama.cpp OOM while evaluating prompt: "please retry the download vision token"',
    )).toBe('runtime:memory_error:completion_failed');
  });

  it('does not promote coarse native failures from quoted user prompt keywords', () => {
    expect(sanitizeMultimodalFailureCategory(
      'llama.rn native failure for prompt payload "oom retry download vision prompt token /private/mobile/photo.jpg"',
    )).toBe('runtime:failed');
  });

  it('keeps trusted error-context path and retry categories', () => {
    expect(sanitizeMultimodalFailureCategory(
      'Native runtime error while resolving file:///private/mobile/model.gguf after retry',
    )).toBe('runtime:projector_unavailable:path_redacted:retry');
  });

  it('keeps trusted download and support categories outside quoted prompt payloads', () => {
    expect(sanitizeMultimodalFailureCategory('Native projector download failed after retries')).toBe(
      'runtime:projector_download_failed:retry',
    );
    expect(sanitizeMultimodalFailureCategory('Native vision support unavailable')).toBe(
      'runtime:vision_support_unavailable',
    );
  });
});
