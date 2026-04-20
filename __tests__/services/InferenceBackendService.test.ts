import * as llamaRn from 'llama.rn';
import { inferenceBackendService } from '../../src/services/InferenceBackendService';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

jest.mock('llama.rn', () => ({
  getBackendDevicesInfo: jest.fn().mockResolvedValue([]),
}));

function getBackendDevicesInfoMock(): jest.Mock {
  return (llamaRn as unknown as { getBackendDevicesInfo: jest.Mock }).getBackendDevicesInfo;
}

describe('InferenceBackendService', () => {
  beforeEach(() => {
    inferenceBackendService.clearCache();
    getBackendDevicesInfoMock().mockReset();
    getBackendDevicesInfoMock().mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats missing backend discovery API as unavailable for safety', async () => {
    const llamaAny = jest.requireMock('llama.rn') as unknown as Record<string, unknown>;
    const previous = llamaAny.getBackendDevicesInfo;

    try {
      delete llamaAny.getBackendDevicesInfo;
      inferenceBackendService.clearCache();

      await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual({
        gpuBackendAvailable: null,
        npuBackendAvailable: null,
        discoveryUnavailable: true,
        devices: [],
      });
    } finally {
      llamaAny.getBackendDevicesInfo = previous;
    }
  });

  it('reports CPU-only availability when no accelerator devices are discovered', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual({
      gpuBackendAvailable: false,
      npuBackendAvailable: false,
      discoveryUnavailable: false,
      devices: [],
    });
  });

  it('reports NPU-only availability when only HTP devices are present', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        maxMemorySize: 0,
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: false,
      npuBackendAvailable: true,
    }));
  });

  it('treats QNN/Hexagon devices as NPU even when deviceName does not start with HTP', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'QNN',
        deviceName: 'Qualcomm Hexagon',
        maxMemorySize: 0,
        metadata: {
          socModel: 'SM8550',
        },
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: false,
      npuBackendAvailable: true,
    }));
  });

  it('reports GPU-only availability when only non-HTP accelerator devices are present', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
      npuBackendAvailable: false,
    }));
  });

  it('reports OpenCL GPU availability even on older Adreno models', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 660',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
    }));
  });

  it('reports OpenCL GPU availability when backend is OpenCL', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'GPUOpenCL',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
    }));
  });

  it('does not require device-name heuristics for OpenCL availability', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'GPUOpenCL',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
    }));
  });

  it('reports Hexagon/HTP NPU availability even on older SoCs', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        maxMemorySize: 0,
        metadata: {
          socModel: 'SM8350',
        },
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      npuBackendAvailable: true,
    }));
  });

  it('reports Hexagon/HTP NPU availability when backend is HTP', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      npuBackendAvailable: true,
    }));
  });

  it('reports both GPU and NPU availability when upstream lists both device types', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'HTP',
        deviceName: 'HTP0',
        maxMemorySize: 0,
      },
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: true,
      npuBackendAvailable: true,
    }));
  });

  it('caches backend discovery for the lifetime of the service', async () => {
    getBackendDevicesInfoMock().mockResolvedValue([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 740',
        maxMemorySize: 0,
      },
    ]);

    await inferenceBackendService.getCapabilitiesSummary();
    await inferenceBackendService.getCapabilitiesSummary();

    expect(getBackendDevicesInfoMock()).toHaveBeenCalledTimes(1);

    inferenceBackendService.clearCache();
    await inferenceBackendService.getCapabilitiesSummary();

    expect(getBackendDevicesInfoMock()).toHaveBeenCalledTimes(2);
  });

  it('times out backend discovery and allows subsequent retries', async () => {
    jest.useFakeTimers();

    getBackendDevicesInfoMock().mockImplementation(() => new Promise(() => { /* never resolves */ }));

    const first = inferenceBackendService.getBackendDevicesInfo();
    jest.advanceTimersByTime(9000);
    await expect(first).resolves.toBeNull();

    getBackendDevicesInfoMock().mockResolvedValueOnce([]);
    await expect(inferenceBackendService.getBackendDevicesInfo()).resolves.toEqual([]);
    expect(getBackendDevicesInfoMock()).toHaveBeenCalledTimes(2);
  });

  it('handles synchronous backend discovery errors without leaking the timeout and allows retries', async () => {
    jest.useFakeTimers();

    getBackendDevicesInfoMock().mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(inferenceBackendService.getBackendDevicesInfo()).resolves.toBeNull();

    // If the timeout wasn't cleared, a pending timer would remain under fake timers.
    const anyJest = jest as unknown as { getTimerCount?: () => number };
    if (typeof anyJest.getTimerCount === 'function') {
      expect(anyJest.getTimerCount()).toBe(0);
    }

    getBackendDevicesInfoMock().mockResolvedValueOnce([]);
    await expect(inferenceBackendService.getBackendDevicesInfo()).resolves.toEqual([]);
  });
});
