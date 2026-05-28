import { ModelAccessState, LifecycleStatus } from '../../src/types/models';
import { buildModelDetailsHeroMetrics, createModelDetailsPlaceholder } from '../../src/utils/modelDetailsPresentation';

describe('modelDetailsPresentation', () => {
  it('uses the short repo label in placeholder model details', () => {
    const placeholder = createModelDetailsPlaceholder('author/model-q4');

    expect(placeholder).toEqual(expect.objectContaining({
      id: 'author/model-q4',
      name: 'model-q4',
      author: 'author',
      accessState: ModelAccessState.PUBLIC,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
    }));
  });

  it('includes active variant projector bytes in hero file size metrics', () => {
    const metrics = buildModelDetailsHeroMetrics({
      id: 'org/model',
      name: 'Model',
      author: 'org',
      size: 3_800_000_000,
      downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
      fitsInRam: true,
      accessState: ModelAccessState.PUBLIC,
      isGated: false,
      isPrivate: false,
      lifecycleStatus: LifecycleStatus.AVAILABLE,
      downloadProgress: 0,
      activeVariantId: 'model.Q4_K_M.gguf',
      variants: [{
        variantId: 'model.Q4_K_M.gguf',
        fileName: 'model.Q4_K_M.gguf',
        quantizationLabel: 'Q4_K_M',
        size: 3_800_000_000,
        projectorCandidates: [{
          id: 'projector-org-model-main-mmproj-model-f16.gguf',
          ownerModelId: 'org/model',
          ownerVariantId: 'model.Q4_K_M.gguf',
          repoId: 'org/model',
          fileName: 'mmproj-model-f16.gguf',
          downloadUrl: 'https://huggingface.co/org/model/resolve/main/mmproj-model-f16.gguf',
          size: 200_000_000,
          lifecycleStatus: 'available',
          matchStatus: 'matched',
        }],
      }],
    }, (key) => (key === 'models.sizeUnknown' ? 'Unknown' : key));

    expect(metrics[0]).toEqual(expect.objectContaining({
      label: 'models.fileSizeLabel',
      value: '4.00 GB',
    }));
  });
});
