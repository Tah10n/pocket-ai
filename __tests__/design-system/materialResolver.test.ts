import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import {
  resolveMaterialRecipe,
  themeUsesAndroidTargetBlur,
} from '../../src/design-system/materials/resolver';
import { resolveTheme } from '../../src/design-system/themes/resolver';

const iosNativeEnvironment = createMaterialEnvironment('ios', {
  blurViewAvailable: true,
  liquidGlassComponentAvailable: true,
  liquidGlassApiAvailable: true,
  transparencyState: 'allowed',
});

describe('material resolver', () => {
  it('derives Android target ownership from chrome recipes instead of theme identity', () => {
    expect(themeUsesAndroidTargetBlur(resolveTheme('default', 'light').materials)).toBe(false);
    expect(themeUsesAndroidTargetBlur(resolveTheme('glass', 'light').materials)).toBe(true);
  });

  it('discovers future overlay fallback and floating-control target blur recipes', () => {
    const denseMaterials = resolveTheme('default', 'light').materials;
    const liquidMaterials = resolveTheme('glass', 'light').materials;
    const densePopover = denseMaterials.overlay.popover.neutral;
    const liquidHeader = liquidMaterials.chrome.header.neutral;
    const overlayFallbackMaterials = {
      ...denseMaterials,
      overlay: {
        ...denseMaterials.overlay,
        popover: {
          neutral: {
            ...densePopover,
            preferredByPlatform: {
              ...densePopover.preferredByPlatform,
              android: liquidHeader.preferredByPlatform.ios,
            },
            platformFallbackByPlatform: {
              android: liquidHeader.preferredByPlatform.android,
            },
          },
        },
      },
    };
    const floatingControlMaterials = {
      ...denseMaterials,
      control: {
        ...denseMaterials.control,
        floating: liquidMaterials.control.floating,
      },
    };

    expect(themeUsesAndroidTargetBlur(overlayFallbackMaterials)).toBe(true);
    expect(themeUsesAndroidTargetBlur(floatingControlMaterials)).toBe(true);
  });

  it('keeps default-theme roles dense and returns stable recipe references', () => {
    const theme = resolveTheme('default', 'light');
    const requests = [
      { role: 'canvas' as const },
      { role: 'content' as const, variant: 'list' as const },
      { role: 'chrome' as const, variant: 'header' as const },
      { role: 'control' as const, variant: 'inline' as const },
      { role: 'overlay' as const, variant: 'popover' as const },
    ];

    for (const request of requests) {
      const first = resolveMaterialRecipe(theme.materials, request, iosNativeEnvironment);
      const second = resolveMaterialRecipe(theme.materials, request, iosNativeEnvironment);

      expect(['solid', 'tinted']).toContain(first.renderer);
      expect(second).toBe(first);
    }
  });

  it('never promotes glass content or list surfaces to live effects', () => {
    const theme = resolveTheme('glass', 'dark');

    for (const variant of ['raised', 'inset', 'list'] as const) {
      expect(resolveMaterialRecipe(
        theme.materials,
        { role: 'content', variant },
        iosNativeEnvironment,
      ).renderer).toBe('tinted');
    }
  });

  it('uses native Liquid Glass only when both APIs and transparency permission are confirmed', () => {
    const theme = resolveTheme('glass', 'light');
    const request = { role: 'chrome' as const, variant: 'header' as const };

    expect(resolveMaterialRecipe(theme.materials, request, iosNativeEnvironment).renderer)
      .toBe('native-liquid-glass');

    for (const transparencyState of ['unknown', 'reduced'] as const) {
      const environment = createMaterialEnvironment('ios', {
        blurViewAvailable: true,
        liquidGlassComponentAvailable: true,
        liquidGlassApiAvailable: true,
        transparencyState,
      });

      expect(resolveMaterialRecipe(theme.materials, request, environment).renderer).toBe('tinted');
    }
  });

  it('falls back from unavailable iOS Liquid Glass to BlurView, then to dense tint', () => {
    const theme = resolveTheme('glass', 'dark');
    const request = { role: 'chrome' as const, variant: 'composer' as const };
    const legacyBlurEnvironment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassComponentAvailable: false,
      liquidGlassApiAvailable: false,
      transparencyState: 'allowed',
    });
    const unsupportedEnvironment = createMaterialEnvironment('ios', {
      blurViewAvailable: false,
      liquidGlassComponentAvailable: false,
      liquidGlassApiAvailable: false,
      transparencyState: 'allowed',
    });

    expect(resolveMaterialRecipe(theme.materials, request, legacyBlurEnvironment).renderer).toBe('blur');
    expect(resolveMaterialRecipe(theme.materials, request, unsupportedEnvironment).renderer).toBe('tinted');
  });

  it('allows Android target blur only on SDK 31+ with a registered capability', () => {
    const theme = resolveTheme('glass', 'light');
    const request = { role: 'chrome' as const, variant: 'tabBar' as const };
    const supported = createMaterialEnvironment('android', {
      androidSdkVersion: 31,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });
    const oldSdk = createMaterialEnvironment('android', {
      androidSdkVersion: 30,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });
    const missingTargetCapability = createMaterialEnvironment('android', {
      androidSdkVersion: 35,
      androidTargetBlurSupported: false,
      transparencyState: 'allowed',
    });

    expect(resolveMaterialRecipe(theme.materials, request, supported).renderer).toBe('blur');
    expect(resolveMaterialRecipe(theme.materials, request, oldSdk).renderer).toBe('tinted');
    expect(resolveMaterialRecipe(theme.materials, request, missingTargetCapability).renderer).toBe('tinted');
  });

  it('uses dense web recipes and resolves semantic tone overrides without allocation', () => {
    const theme = resolveTheme('glass', 'light');
    const web = createMaterialEnvironment('web', { transparencyState: 'allowed' });
    const neutralControl = resolveMaterialRecipe(
      theme.materials,
      { role: 'control', variant: 'inline', tone: 'neutral' },
      web,
    );
    const errorControl = resolveMaterialRecipe(
      theme.materials,
      { role: 'control', variant: 'inline', tone: 'error' },
      web,
    );
    const chrome = resolveMaterialRecipe(
      theme.materials,
      { role: 'chrome', variant: 'sheet' },
      web,
    );

    expect(neutralControl.renderer).toBe('tinted');
    expect(errorControl.renderer).toBe('tinted');
    expect(errorControl.fill.color).not.toBe(neutralControl.fill.color);
    expect(chrome.renderer).toBe('tinted');
    expect(resolveMaterialRecipe(
      theme.materials,
      { role: 'control', variant: 'inline', tone: 'error' },
      web,
    )).toBe(errorControl);
  });
});
