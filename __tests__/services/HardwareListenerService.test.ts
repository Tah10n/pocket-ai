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
