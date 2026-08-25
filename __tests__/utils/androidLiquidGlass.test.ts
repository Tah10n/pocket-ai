import {
  getAndroidLiquidGlassSurfaceParameters,
  resolveAndroidGlassCapability,
  withAndroidBackdropTargetState,
} from '../../src/utils/androidLiquidGlass';

describe('Android Liquid Glass capability', () => {
  it.each([
    [33, 'android-liquid-glass'],
    [35, 'android-liquid-glass'],
    [31, 'dense'],
    [32, 'dense'],
    [30, 'dense'],
  ] as const)('resolves API %s to %s', (apiLevel, renderer) => {
    expect(resolveAndroidGlassCapability({ apiLevel, platform: 'android' }).renderer).toBe(renderer);
  });

  it.each([
    [{ effectsEnabled: false }, 'dense'],
    [{ nativeRendererAvailable: false }, 'dense'],
    [{ rendererFailed: true }, 'dense'],
  ] as const)('falls back after capability or renderer failure', (input, renderer) => {
    expect(resolveAndroidGlassCapability({ apiLevel: 33, platform: 'android', ...input }).renderer)
      .toBe(renderer);
  });

  it('tracks pending, ready, and detached targets without retaining a renderer after detach', () => {
    const pending = resolveAndroidGlassCapability({ apiLevel: 33, platform: 'android' });
    expect(pending).toEqual({ renderer: 'android-liquid-glass', targetState: 'pending' });
    expect(withAndroidBackdropTargetState(pending, 'ready')).toEqual({
      renderer: 'android-liquid-glass',
      targetState: 'ready',
    });
    expect(withAndroidBackdropTargetState(pending, 'detached')).toEqual({
      renderer: 'dense',
      targetState: 'detached',
    });
  });

  it('maps light/dark parameters and disables native interaction for disabled controls', () => {
    expect(getAndroidLiquidGlassSurfaceParameters({ mode: 'light', interactive: true }))
      .toEqual({ dark: false, interactive: true });
    expect(getAndroidLiquidGlassSurfaceParameters({ mode: 'dark', interactive: true, disabled: true }))
      .toEqual({ dark: true, interactive: false });
  });

  it('never enables Android rendering on iOS', () => {
    expect(resolveAndroidGlassCapability({ apiLevel: 33, platform: 'ios' })).toEqual({
      renderer: 'dense',
      targetState: 'detached',
    });
  });
});
