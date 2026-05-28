import { redactPathLikeValues, sanitizeMultimodalFailureReason } from '../../src/utils/multimodalFailureReason';

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
});
