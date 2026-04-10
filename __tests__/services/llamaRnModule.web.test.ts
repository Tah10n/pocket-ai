import { requireLlamaModule } from '../../src/services/llamaRnModule.web';

describe('llamaRnModule.web', () => {
  it('throws a helpful error on web builds', () => {
    expect(() => requireLlamaModule()).toThrow('llama.rn is not available on web builds');
  });
});

