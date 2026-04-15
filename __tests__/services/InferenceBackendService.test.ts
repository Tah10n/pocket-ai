import * as llamaRn from 'llama.rn';
import { inferenceBackendService } from '../../src/services/InferenceBackendService';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
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

  it('disables OpenCL GPU availability on Adreno below 700 for stability', async () => {
    getBackendDevicesInfoMock().mockResolvedValueOnce([
      {
        type: 'gpu',
        backend: 'OpenCL',
        deviceName: 'QUALCOMM Adreno(TM) 660',
        maxMemorySize: 0,
      },
    ]);

    await expect(inferenceBackendService.getBackendAvailability()).resolves.toEqual(expect.objectContaining({
      gpuBackendAvailable: false,
    }));
  });

  it('disables Hexagon/HTP NPU availability on pre-SM8450 devices for stability', async () => {
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
      npuBackendAvailable: false,
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
});
