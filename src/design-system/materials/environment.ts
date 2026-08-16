import type { MaterialEnvironment, MaterialPlatform } from './contract';

export const FAIL_CLOSED_MATERIAL_ENVIRONMENT: MaterialEnvironment = Object.freeze({
  platform: 'web',
  blurViewAvailable: false,
  androidTargetBlurSupported: false,
  liquidGlassComponentAvailable: false,
  liquidGlassApiAvailable: false,
  transparencyState: 'unknown',
});

export function createMaterialEnvironment(
  platform: MaterialPlatform,
  overrides: Partial<Omit<MaterialEnvironment, 'platform'>> = {},
): MaterialEnvironment {
  return Object.freeze({
    ...FAIL_CLOSED_MATERIAL_ENVIRONMENT,
    platform,
    ...overrides,
  });
}
