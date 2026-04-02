import { getChatHardwareBannerInputs } from '../../src/services/HardwareListenerService';

describe('HardwareListenerService chat banner inputs', () => {
  it('maps low-memory and thermal warnings into chat banner inputs', () => {
    expect(getChatHardwareBannerInputs({
      isLowMemory: true,
      isConnected: true,
      networkType: 'wifi',
      thermalState: 'serious',
    })).toEqual({
      showLowMemoryWarning: true,
      showThermalWarning: true,
      thermalState: 'serious',
    });
  });

  it('keeps banner warnings disabled for nominal device state', () => {
    expect(getChatHardwareBannerInputs({
      isLowMemory: false,
      isConnected: true,
      networkType: 'wifi',
      thermalState: 'nominal',
    })).toEqual({
      showLowMemoryWarning: false,
      showThermalWarning: false,
      thermalState: 'nominal',
    });
  });
});

describe('HardwareListenerService network status', () => {
  it('does not treat unknown reachability as offline', () => {
    jest.isolateModules(() => {
      const { hardwareListenerService } = require('../../src/services/HardwareListenerService');
      expect(hardwareListenerService.getCurrentStatus().isConnected).toBe(true);

      (hardwareListenerService as any).handleNetworkChange({
        type: 'unknown',
        isConnected: null,
        isInternetReachable: null,
      });

      expect(hardwareListenerService.getCurrentStatus().isConnected).toBe(true);
    });
  });

  it('updates reachability when NetInfo provides a boolean', () => {
    jest.isolateModules(() => {
      const { hardwareListenerService } = require('../../src/services/HardwareListenerService');

      (hardwareListenerService as any).handleNetworkChange({
        type: 'none',
        isConnected: false,
        isInternetReachable: false,
      });

      expect(hardwareListenerService.getCurrentStatus().isConnected).toBe(false);
    });
  });
});
