describe('llamaRnModule', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('llama.rn');
  });

  it('rethrows the cached module load error without retrying require', () => {
    const loadError = new Error('native llama unavailable');
    let loadAttempts = 0;

    jest.doMock('llama.rn', () => {
      loadAttempts += 1;
      throw loadError;
    });

    jest.isolateModules(() => {
      const { requireLlamaModule } = require('../../src/services/llamaRnModule');

      expect(() => requireLlamaModule()).toThrow(loadError);
      expect(() => requireLlamaModule()).toThrow(loadError);
      expect(loadAttempts).toBe(1);
    });
  });

  it('normalizes non-Error throws into Error instances', () => {
    jest.doMock('llama.rn', () => {
      throw 'module exploded';
    });

    jest.isolateModules(() => {
      const { requireLlamaModule } = require('../../src/services/llamaRnModule');

      try {
        requireLlamaModule();
        throw new Error('expected requireLlamaModule to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('module exploded');
      }
    });
  });
});
