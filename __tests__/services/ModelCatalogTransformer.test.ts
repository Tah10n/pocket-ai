import {
  buildModelMetadataFromPayload,
  createFallbackModel,
  transformHFResponse,
} from '../../src/services/ModelCatalogTransformer';

describe('ModelCatalogTransformer', () => {
  it('uses the short repo label for fallback models', () => {
    const model = createFallbackModel('author/model-q4');

    expect(model.name).toBe('model-q4');
    expect(model.author).toBe('author');
  });

  it('uses the short repo label for tree-probe catalog candidates without a display name', () => {
    const models = transformHFResponse([
      {
        id: 'author/model-q4',
        tags: ['gguf', 'chat'],
        gguf: {
          total: 1_000_000_000,
        },
      },
    ], null, null);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      id: 'author/model-q4',
      name: 'model-q4',
      author: 'author',
      requiresTreeProbe: true,
    }));
  });

  it('recomputes the short repo label when payload metadata changes the repo id', () => {
    const result = buildModelMetadataFromPayload(
      {
        modelId: 'author/model-q8',
        tags: ['gguf', 'chat'],
        gguf: {
          total: 2_000_000_000,
        },
      },
      null,
      null,
      {
        ...createFallbackModel('author/model-q4'),
        name: 'stale-name',
      },
    );

    expect(result.id).toBe('author/model-q8');
    expect(result.name).toBe('model-q8');
    expect(result.author).toBe('author');
  });
});
