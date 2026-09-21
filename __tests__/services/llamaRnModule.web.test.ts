describe('llamaRnModule.web', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('llama.rn');
  });

  it('returns unsupported diagnostics and errors without importing native code', () => {
    const factory = jest.fn(() => { throw new Error('native import forbidden'); });
    jest.doMock('llama.rn', factory);
    jest.isolateModules(() => {
      const { requireLlamaModule, getLlamaRuntimeDiagnostics } = jest.requireActual<typeof import('../../src/services/llamaRnModule.web')>('../../src/services/llamaRnModule.web');
      expect(getLlamaRuntimeDiagnostics()).toEqual(expect.objectContaining({
        moduleLoadState: 'unavailable_on_web',
        buildInfo: undefined,
        nativeBinaryVersion: 'unverified',
        moduleApiShape: { status: 'not_checked', missingMethods: [] },
        activeContextApiShape: { status: 'no_active_context', missingMethods: [] },
      }));
      expect(() => requireLlamaModule()).toThrow('llama.rn is not available on web builds');
      expect(factory).not.toHaveBeenCalled();
    });
  });
});
