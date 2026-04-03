import { DECIMAL_GIGABYTE, formatModelFileSize } from '../../src/utils/modelSize';

describe('modelSize', () => {
  it('formats positive model file sizes as decimal GB with two decimals', () => {
    expect(formatModelFileSize(DECIMAL_GIGABYTE, 'Unknown')).toBe('1.00 GB');
    expect(formatModelFileSize(1.5 * DECIMAL_GIGABYTE, 'Unknown')).toBe('1.50 GB');
  });

  it('returns the unknown label for invalid values', () => {
    expect(formatModelFileSize(null, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(undefined, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(NaN, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(0, 'Unknown')).toBe('Unknown');
    expect(formatModelFileSize(-10, 'Unknown')).toBe('Unknown');
  });
});

