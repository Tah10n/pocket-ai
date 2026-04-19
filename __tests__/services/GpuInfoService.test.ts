describe('GpuInfoService', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('returns null when native module is unavailable', async () => {
    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' },
      NativeModules: {},
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAndroidGpuInfo, clearAndroidGpuInfoCache } = require('../../src/services/GpuInfoService') as typeof import('../../src/services/GpuInfoService');

    clearAndroidGpuInfoCache();
    await expect(getAndroidGpuInfo()).resolves.toBeNull();
    await expect(getAndroidGpuInfo()).resolves.toBeNull();
  });

  it('dedupes inflight calls, normalizes strings, and caches results', async () => {
    const getGpuInfo = jest.fn().mockResolvedValue({
      glRenderer: '  Adreno 740  ',
      glVendor: ' Qualcomm ',
      glVersion: '  OpenGL ES 3.2  ',
      socModel: '  SM8550 ',
      socManufacturer: ' Qualcomm ',
      board: '  board  ',
      hardware: '  hw  ',
      device: '  dev  ',
      product: '  prod  ',
      brand: '  brand  ',
      model: '  model  ',
      manufacturer: '  mfg  ',
    });

    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' },
      NativeModules: {
        GpuInfo: { getGpuInfo },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAndroidGpuInfo, clearAndroidGpuInfoCache } = require('../../src/services/GpuInfoService') as typeof import('../../src/services/GpuInfoService');

    clearAndroidGpuInfoCache();
    const [a, b] = await Promise.all([getAndroidGpuInfo(), getAndroidGpuInfo()]);

    expect(getGpuInfo).toHaveBeenCalledTimes(1);
    expect(a).toEqual(expect.objectContaining({
      glRenderer: 'Adreno 740',
      glVendor: 'Qualcomm',
      glVersion: 'OpenGL ES 3.2',
      socModel: 'SM8550',
      socManufacturer: 'Qualcomm',
    }));
    expect(b).toEqual(a);

    await expect(getAndroidGpuInfo()).resolves.toEqual(a);
    expect(getGpuInfo).toHaveBeenCalledTimes(1);
  });

  it('returns null when native call throws and does not cache the failure', async () => {
    const getGpuInfo = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ glRenderer: 'Adreno' });

    jest.doMock('react-native', () => ({
      Platform: { OS: 'android' },
      NativeModules: {
        GpuInfo: { getGpuInfo },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAndroidGpuInfo, clearAndroidGpuInfoCache } = require('../../src/services/GpuInfoService') as typeof import('../../src/services/GpuInfoService');

    clearAndroidGpuInfoCache();
    await expect(getAndroidGpuInfo()).resolves.toBeNull();
    clearAndroidGpuInfoCache();
    await expect(getAndroidGpuInfo()).resolves.toEqual(expect.objectContaining({ glRenderer: 'Adreno' }));
    expect(getGpuInfo).toHaveBeenCalledTimes(2);
  });
});
