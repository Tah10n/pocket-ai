import { mergeModelWithRuntimeState } from '../../src/utils/modelRuntimeState';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../src/types/models';

function makeModel(overrides: Partial<ModelMetadata> = {}): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: null,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    fitsInRam: null,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
    ...overrides,
  };
}

describe('modelRuntimeState', () => {
  it('preserves enriched registry metadata when the incoming model is sparse', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel(),
      {
        localModel: makeModel({
          localPath: '/models/model.gguf',
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
          parameterSizeLabel: '8B',
          baseModels: ['meta-llama/Llama-3.1-8B-Instruct'],
          license: 'llama3.1',
          languages: ['en', 'de'],
          datasets: ['ultrachat_200k'],
          quantizedBy: 'bartowski',
          modelCreator: 'Meta',
        }),
      },
    );

    expect(merged.localPath).toBe('/models/model.gguf');
    expect(merged.lifecycleStatus).toBe(LifecycleStatus.DOWNLOADED);
    expect(merged.parameterSizeLabel).toBe('8B');
    expect(merged.baseModels).toEqual(['meta-llama/Llama-3.1-8B-Instruct']);
    expect(merged.license).toBe('llama3.1');
    expect(merged.languages).toEqual(['en', 'de']);
    expect(merged.datasets).toEqual(['ultrachat_200k']);
    expect(merged.quantizedBy).toBe('bartowski');
    expect(merged.modelCreator).toBe('Meta');
  });

  it('does not overwrite richer incoming metadata with local fallbacks', () => {
    const merged = mergeModelWithRuntimeState(
      makeModel({
        parameterSizeLabel: '14B',
        baseModels: ['upstream/model'],
        license: 'apache-2.0',
        languages: ['en'],
        datasets: ['custom-dataset'],
        quantizedBy: 'maintainer',
        modelCreator: 'Open Source Lab',
      }),
      {
        localModel: makeModel({
          parameterSizeLabel: '8B',
          baseModels: ['meta-llama/Llama-3.1-8B-Instruct'],
          license: 'llama3.1',
          languages: ['de'],
          datasets: ['ultrachat_200k'],
          quantizedBy: 'bartowski',
          modelCreator: 'Meta',
        }),
      },
    );

    expect(merged.parameterSizeLabel).toBe('14B');
    expect(merged.baseModels).toEqual(['upstream/model']);
    expect(merged.license).toBe('apache-2.0');
    expect(merged.languages).toEqual(['en']);
    expect(merged.datasets).toEqual(['custom-dataset']);
    expect(merged.quantizedBy).toBe('maintainer');
    expect(merged.modelCreator).toBe('Open Source Lab');
  });
});
