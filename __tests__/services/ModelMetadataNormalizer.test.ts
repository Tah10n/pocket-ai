import { normalizePersistedModelMetadata } from '../../src/services/ModelMetadataNormalizer';
import { LifecycleStatus, ModelAccessState } from '../../src/types/models';

describe('ModelMetadataNormalizer', () => {
  it('maps zero-size legacy metadata to unknown size and nullable RAM fit', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      name: 'Legacy model',
      author: 'legacy',
      size: 0,
      downloadUrl: 'https://huggingface.co/legacy/model/resolve/main/model.gguf',
      fitsInRam: true,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
    });

    expect(normalized.size).toBeNull();
    expect(normalized.fitsInRam).toBeNull();
  });

  it('fills auth defaults for persisted records that predate gated-model support', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
    });

    expect(normalized.accessState).toBe(ModelAccessState.PUBLIC);
    expect(normalized.isGated).toBe(false);
    expect(normalized.isPrivate).toBe(false);
  });

  it('preserves the verified context-window marker when present', () => {
    const normalized = normalizePersistedModelMetadata({
      id: 'legacy/model',
      lifecycleStatus: LifecycleStatus.DOWNLOADED,
      downloadProgress: 1,
      hasVerifiedContextWindow: true,
    });

    expect(normalized.hasVerifiedContextWindow).toBe(true);
  });
});
