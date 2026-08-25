import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import {
  resolveMaterialRecipe,
  themeNeedsAndroidTargetBlur,
  themeUsesAndroidLiquidGlass,
} from '../../src/design-system/materials/resolver';
import { resolveTheme } from '../../src/design-system/themes/resolver';

const iosNativeEnvironment = createMaterialEnvironment('ios', {
  blurViewAvailable: true,
  liquidGlassComponentAvailable: true,
  liquidGlassApiAvailable: true,
  transparencyState: 'allowed',
});

describe('material resolver', () => {
  it('derives Android target ownership from the renderer resolved for the environment', () => {
    const denseMaterials = resolveTheme('default', 'light').materials;
    const liquidMaterials = resolveTheme('glass', 'light').materials;
    const nativeEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });
    const legacyEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 32,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });

    expect(themeNeedsAndroidTargetBlur(denseMaterials, nativeEnvironment)).toBe(false);
    expect(themeNeedsAndroidTargetBlur(liquidMaterials, nativeEnvironment)).toBe(false);
    expect(themeNeedsAndroidTargetBlur(liquidMaterials, legacyEnvironment)).toBe(true);
  });

  it('selects native Android glass only on API 33+ with the native view available', () => {
    const materials = resolveTheme('glass', 'light').materials;
    const request = { role: 'chrome' as const, variant: 'composer' as const };
    expect(themeUsesAndroidLiquidGlass(materials)).toBe(true);
    expect(resolveMaterialRecipe(materials, request, createMaterialEnvironment('android', {
      androidSdkVersion: 33,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    })).renderer).toBe('android-liquid-glass');
    expect(resolveMaterialRecipe(materials, request, createMaterialEnvironment('android', {
      androidSdkVersion: 32,
      androidLiquidGlassAvailable: false,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    })).renderer).toBe('blur');
  });

  it('keeps warning popover fallback semantic when effects are unavailable', () => {
    const theme = resolveTheme('glass', 'light');
    const recipe = resolveMaterialRecipe(
      theme.materials,
      { role: 'overlay', variant: 'popover', tone: 'warning' },
      createMaterialEnvironment('android', { androidSdkVersion: 30, transparencyState: 'allowed' }),
    );
    expect(recipe).toMatchObject({
      renderer: 'tinted',
      fill: { color: theme.colors.warningSurface },
    });
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
              android: liquidHeader.platformFallbackByPlatform?.android,
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

    const nativeEnvironment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidLiquidGlassAvailable: true,
      androidTargetBlurSupported: true,
      transparencyState: 'allowed',
    });

    expect(themeNeedsAndroidTargetBlur(overlayFallbackMaterials, nativeEnvironment)).toBe(true);
    expect(themeNeedsAndroidTargetBlur(floatingControlMaterials, nativeEnvironment)).toBe(false);

    const blurOnlyFloatingControlMaterials = {
      ...denseMaterials,
      control: {
        ...denseMaterials.control,
        floating: {
          neutral: {
            ...liquidMaterials.control.floating.neutral,
            preferredByPlatform: {
              ...liquidMaterials.control.floating.neutral.preferredByPlatform,
              android: liquidMaterials.control.floating.neutral.platformFallbackByPlatform!.android!,
            },
          },
        },
      },
    };
    expect(themeNeedsAndroidTargetBlur(blurOnlyFloatingControlMaterials, nativeEnvironment)).toBe(true);
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

  it.each([
    ['light', 15, 0.01, null],
    ['dark', 18, 0.075, 0.18],
  ] as const)(
    'keeps the %s glass tab bar ultra-thin while preserving live Android blur',
    (mode, intensity, tintOpacity, contrastOpacity) => {
      const theme = resolveTheme('glass', mode);
      const recipe = resolveMaterialRecipe(
        theme.materials,
        { role: 'chrome', variant: 'tabBar' },
        createMaterialEnvironment('android', {
          androidSdkVersion: 31,
          androidTargetBlurSupported: true,
          transparencyState: 'allowed',
        }),
      );

      expect(recipe).toMatchObject({
        renderer: 'blur',
        fill: { color: mode === 'dark' ? '#f4f7fb' : '#f8fafc', opacity: 0 },
        tint: {
          color: mode === 'dark' ? '#f4f7fb' : '#f8fafc',
          opacity: tintOpacity,
        },
        rim: { opacity: 0, width: 0 },
        shadow: { opacity: 0, elevation: 0 },
        blur: {
          intensity,
          tint: mode === 'dark' ? 'dark' : 'default',
          androidBlurReductionDivisor: 1,
        },
      });
      expect(recipe.contrastFilm).toEqual(contrastOpacity === null
        ? null
        : { color: '#060b14', opacity: contrastOpacity });
    },
  );

  it.each([
    ['light', { color: '#f8fafc', opacity: 0.24 }, null],
    ['dark', { color: '#060b14', opacity: 0.24 }, { color: '#f4f7fb', opacity: 0.22 }],
  ] as const)(
    'preserves the legacy %s dense tab bar fallback paints',
    (mode, fill, tint) => {
      const theme = resolveTheme('glass', mode);
      const recipe = resolveMaterialRecipe(
        theme.materials,
        { role: 'chrome', variant: 'tabBar' },
        createMaterialEnvironment('android', {
          androidSdkVersion: 31,
          androidTargetBlurSupported: false,
          transparencyState: 'allowed',
        }),
      );

      expect(recipe).toMatchObject({
        renderer: 'tinted',
        fill,
        tint,
        contrastFilm: null,
        rim: { opacity: 0, width: 0 },
        shadow: { opacity: 0, elevation: 0 },
      });
    },
  );

  it('uses clear native Liquid Glass for the floating iOS tab bar', () => {
    const theme = resolveTheme('glass', 'light');
    const recipe = resolveMaterialRecipe(
      theme.materials,
      { role: 'chrome', variant: 'tabBar' },
      createMaterialEnvironment('ios', {
        blurViewAvailable: true,
        liquidGlassApiAvailable: true,
        liquidGlassComponentAvailable: true,
        transparencyState: 'allowed',
      }),
    );

    expect(recipe).toMatchObject({
      renderer: 'native-liquid-glass',
      fill: { opacity: 0 },
      tint: { opacity: 0.01 },
      rim: { opacity: 0, width: 0 },
      nativeGlass: { style: 'clear' },
    });
  });

  it.each([
    ['light', 'systemUltraThinMaterialLight'],
    ['dark', 'systemUltraThinMaterialDark'],
  ] as const)('keeps the %s iOS BlurView fallback ultra-thin', (mode, tint) => {
    const theme = resolveTheme('glass', mode);
    const recipe = resolveMaterialRecipe(
      theme.materials,
      { role: 'chrome', variant: 'tabBar' },
      createMaterialEnvironment('ios', {
        blurViewAvailable: true,
        liquidGlassApiAvailable: false,
        liquidGlassComponentAvailable: false,
        transparencyState: 'allowed',
      }),
    );

    expect(recipe).toMatchObject({
      renderer: 'blur',
      blur: { tint },
    });
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
