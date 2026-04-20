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

describe('HardwareListenerService lifecycle and subscriptions', () => {
  it('starts and stops listeners, and notifies subscribers on updates', () => {
    jest.isolateModules(() => {
      const removeMemoryWarning = jest.fn();
      const netInfoUnsubscribe = jest.fn();

      const { AppState } = require('react-native');
      const netInfo = require('@react-native-community/netinfo');
      const addEventListener = jest.spyOn(AppState as any, 'addEventListener').mockImplementation((...args: any[]) => {
        const handler = args[1];
        (addEventListener as any).lastHandler = handler;
        return { remove: removeMemoryWarning };
      });
      (netInfo.addEventListener as jest.Mock).mockImplementation((listener: any) => {
        (netInfo.addEventListener as any).lastListener = listener;
        return netInfoUnsubscribe;
      });

      const { hardwareListenerService } = require('../../src/services/HardwareListenerService');

      const subscriber = jest.fn();
      const unsubscribe = hardwareListenerService.subscribe(subscriber);
      expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({
        isLowMemory: false,
        isConnected: true,
      }));

      hardwareListenerService.start();
      hardwareListenerService.start();
      expect(addEventListener).toHaveBeenCalledWith('memoryWarning', expect.any(Function));
      expect(netInfo.addEventListener).toHaveBeenCalledTimes(1);

      // Simulate a network change with reachability.
      (netInfo.addEventListener as any).lastListener?.({ type: 'wifi', isInternetReachable: false, isConnected: true });
      expect(hardwareListenerService.getCurrentStatus().isConnected).toBe(false);
      expect(subscriber).toHaveBeenLastCalledWith(expect.objectContaining({ isConnected: false }));

      // Simulate a memory warning.
      const handler = (addEventListener as any).lastHandler as (() => void) | undefined;
      expect(handler).toBeDefined();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      handler?.();
      warnSpy.mockRestore();
      expect(hardwareListenerService.getCurrentStatus().isLowMemory).toBe(true);

      hardwareListenerService.resetLowMemoryFlag();
      expect(hardwareListenerService.getCurrentStatus().isLowMemory).toBe(false);

      hardwareListenerService.setThermalState('critical');
      expect(hardwareListenerService.getCurrentStatus().thermalState).toBe('critical');

      unsubscribe();
      hardwareListenerService.stop();
      hardwareListenerService.stop();
      expect(removeMemoryWarning).toHaveBeenCalled();
      expect(netInfoUnsubscribe).toHaveBeenCalled();

      addEventListener.mockRestore();
    });
  });
});
