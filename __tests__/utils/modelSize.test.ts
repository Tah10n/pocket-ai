import {
  DECIMAL_GIGABYTE,
  formatModelFileSize,
  getModelDisplayArtifactSizeBytes,
  getModelStoredArtifactsSizeBytes,
  getProjectorMemoryFitSizeBytes,
  getProjectorArtifactsSizeBytes,
  getStoredProjectorArtifactsSizeBytes,
  normalizePositiveByteSize,
} from '../../src/utils/modelSize';

describe('modelSize', () => {
  it('normalizes positive byte sizes and rejects invalid values', () => {
    expect(normalizePositiveByteSize(10.4)).toBe(10);
    expect(normalizePositiveByteSize(null)).toBeNull();
    expect(normalizePositiveByteSize(Number.NaN)).toBeNull();
    expect(normalizePositiveByteSize(0)).toBeNull();
    expect(normalizePositiveByteSize(-1)).toBeNull();
  });

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

  it('sums projector artifact sizes only when storage should count them', () => {
    expect(getProjectorArtifactsSizeBytes([
      { size: 100.4 },
      { size: null },
      { size: 25 },
    ])).toBe(125);

    expect(getStoredProjectorArtifactsSizeBytes([
      { lifecycleStatus: 'downloaded', size: 100 },
      { lifecycleStatus: 'active', size: 50 },
      { lifecycleStatus: 'available', size: 999 },
      { lifecycleStatus: 'failed', size: 999 },
    ])).toBe(150);
  });

  it('includes downloaded projector artifacts in stored model artifact totals', () => {
    expect(getModelStoredArtifactsSizeBytes({
      size: 1_000,
      projectorCandidates: [
        {
          id: 'projector-a',
          ownerModelId: 'model-a',
          repoId: 'repo',
          fileName: 'projector-a.gguf',
          downloadUrl: 'https://example.com/projector-a.gguf',
          size: 250,
          lifecycleStatus: 'downloaded',
          matchStatus: 'matched',
        },
        {
          id: 'projector-b',
          ownerModelId: 'model-a',
          repoId: 'repo',
          fileName: 'projector-b.gguf',
          downloadUrl: 'https://example.com/projector-b.gguf',
          size: 500,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        },
      ],
    })).toBe(1_250);
  });

  it('uses the selected or matched projector size for display and memory-fit totals', () => {
    const projectorCandidates = [
      {
        id: 'projector-a',
        ownerModelId: 'model-a',
        repoId: 'repo',
        fileName: 'projector-a.gguf',
        downloadUrl: 'https://example.com/projector-a.gguf',
        size: 250,
        lifecycleStatus: 'available' as const,
        matchStatus: 'matched' as const,
      },
      {
        id: 'projector-b',
        ownerModelId: 'model-a',
        repoId: 'repo',
        fileName: 'projector-b.gguf',
        downloadUrl: 'https://example.com/projector-b.gguf',
        size: 500,
        lifecycleStatus: 'available' as const,
        matchStatus: 'ambiguous' as const,
      },
    ];

    expect(getProjectorMemoryFitSizeBytes(projectorCandidates)).toBe(250);
    expect(getModelDisplayArtifactSizeBytes({
      size: 1_000,
      projectorCandidates,
    })).toBe(1_250);
    expect(getProjectorMemoryFitSizeBytes(projectorCandidates, 'projector-b')).toBe(500);
    expect(getModelDisplayArtifactSizeBytes({
      size: 1_000,
      projectorCandidates,
      selectedProjectorId: 'projector-b',
    })).toBe(1_500);
  });
});

