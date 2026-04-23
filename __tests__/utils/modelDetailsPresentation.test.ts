import { ModelAccessState, LifecycleStatus } from '../../src/types/models';
import { createModelDetailsPlaceholder } from '../../src/utils/modelDetailsPresentation';

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
});
