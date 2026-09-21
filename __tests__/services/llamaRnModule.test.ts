import appPackageJson from '../../package.json';

describe('llamaRnModule', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('llama.rn');
  });

  it('reads diagnostics without importing native code, then observes the explicitly loaded module', () => {
    const methods = {
      initLlama: jest.fn(), loadLlamaModelInfo: jest.fn(), getBackendDevicesInfo: jest.fn(),
      addNativeLogListener: jest.fn(), toggleNativeLog: jest.fn(), releaseAllLlama: jest.fn(),
    };
    const factory = jest.fn(() => ({ ...methods, BuildInfo: { number: '10829', commit: '5fdfa62' } }));
    jest.doMock('llama.rn', factory);
    jest.isolateModules(() => {
      const { getLlamaRuntimeDiagnostics, requireLlamaModule } = jest.requireActual<typeof import('../../src/services/llamaRnModule')>('../../src/services/llamaRnModule');
      expect(getLlamaRuntimeDiagnostics()).toEqual(expect.objectContaining({
        packageVersion: appPackageJson.dependencies['llama.rn'],
        moduleLoadState: 'not_loaded',
        buildInfo: undefined,
        nativeBinaryVersion: 'unverified',
        moduleApiShape: { status: 'not_checked', missingMethods: [] },
        activeContextApiShape: { status: 'no_active_context', missingMethods: [] },
      }));
      expect(factory).not.toHaveBeenCalled();
      requireLlamaModule();
      const snapshot = getLlamaRuntimeDiagnostics();
      expect(snapshot).toEqual(expect.objectContaining({
        moduleLoadState: 'loaded',
        buildInfoSource: 'js_package',
        buildInfo: { number: '10829', commit: '5fdfa62' },
        nativeBinaryVersion: 'unverified',
        moduleApiShape: { status: 'available', missingMethods: [] },
      }));
      if (!snapshot.buildInfo) throw new Error('expected cached BuildInfo');
      snapshot.buildInfo.number = 'mutated';
      expect(getLlamaRuntimeDiagnostics().buildInfo?.number).toBe('10829');
      expect(factory).toHaveBeenCalledTimes(1);
      Object.values(methods).forEach((method) => expect(method).not.toHaveBeenCalled());
    });
  });

  it('reports missing method shapes and never calls context methods', () => {
    jest.doMock('llama.rn', () => ({ initLlama: false, BuildInfo: { number: '/private/file', commit: 'secret' } }));
    jest.isolateModules(() => {
      const { getLlamaRuntimeDiagnostics, requireLlamaModule } = jest.requireActual<typeof import('../../src/services/llamaRnModule')>('../../src/services/llamaRnModule');
      requireLlamaModule();
      const context = {
        getFormattedChat: jest.fn(), completion: jest.fn(), tokenize: jest.fn(),
        stopCompletion: jest.fn(), release: jest.fn(), initMultimodal: jest.fn(),
        getMultimodalSupport: jest.fn(), releaseMultimodal: jest.fn(),
      };
      const snapshot = getLlamaRuntimeDiagnostics(context);
      expect(snapshot.moduleApiShape.status).toBe('missing_methods');
      expect(snapshot.moduleApiShape.missingMethods).toContain('initLlama');
      expect(snapshot.buildInfo).toBeUndefined();
      expect(snapshot.activeContextApiShape).toEqual({ status: 'available', missingMethods: [] });
      expect(getLlamaRuntimeDiagnostics({}).activeContextApiShape).toEqual({
        status: 'missing_methods', missingMethods: Object.keys(context),
      });
      Object.values(context).forEach((method) => expect(method).not.toHaveBeenCalled());
    });
  });

  it('rethrows the cached module load error without retrying require', () => {
    const loadError = new Error('native llama unavailable');
    let loadAttempts = 0;

    jest.doMock('llama.rn', () => {
      loadAttempts += 1;
      throw loadError;
    });

    jest.isolateModules(() => {
      const { requireLlamaModule, getLlamaRuntimeDiagnostics } = jest.requireActual<typeof import('../../src/services/llamaRnModule')>('../../src/services/llamaRnModule');

      expect(() => requireLlamaModule()).toThrow(loadError);
      expect(() => requireLlamaModule()).toThrow(loadError);
      expect(loadAttempts).toBe(1);
      expect(getLlamaRuntimeDiagnostics()).toEqual(expect.objectContaining({
        moduleLoadState: 'load_failed',
        moduleApiShape: { status: 'not_checked', missingMethods: [] },
      }));
      expect(JSON.stringify(getLlamaRuntimeDiagnostics())).not.toContain(loadError.message);
      expect(loadAttempts).toBe(1);
    });
  });

  it('normalizes non-Error throws into Error instances', () => {
    jest.doMock('llama.rn', () => {
      throw 'module exploded';
    });

    jest.isolateModules(() => {
      const { requireLlamaModule } = jest.requireActual<typeof import('../../src/services/llamaRnModule')>('../../src/services/llamaRnModule');

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
