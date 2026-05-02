import { getThemeAppearance, getThemeColors, tailwindRadiusPxByToken } from '../../src/utils/themeTokens';

const tailwindConfig = require('../../tailwind.config.js') as {
  theme?: {
    extend?: {
      opacity?: Record<string, string>;
    };
  };
};

const defaultTailwindOpacityKeys = new Set([
  '0',
  '5',
  '10',
  '20',
  '25',
  '30',
  '40',
  '50',
  '60',
  '70',
  '75',
  '80',
  '90',
  '95',
  '100',
]);

const layoutClassKeys = [
  'cardClassName',
  'insetCardClassName',
  'textFieldClassName',
  'compactTextFieldClassName',
  'prominentTextFieldClassName',
  'multilineTextFieldClassName',
  'prominentMultilineTextFieldClassName',
  'searchInlineFieldClassName',
  'composerInlineFieldClassName',
  'segmentedControlClassName',
  'sheetClassName',
  'modalOverlayClassName',
  'primaryActionPillClassName',
  'softActionPillClassName',
  'bottomBarClassName',
  'modeBannerClassName',
  'floatingBannerClassName',
  'inlinePillClassName',
  'systemEventPillClassName',
  'chatUserBubbleClassName',
  'chatAssistantBubbleClassName',
  'chatThoughtBubbleClassName',
  'chatInlineErrorClassName',
  'thumbnailSurfaceClassName',
] as const;

const darkGlassNeutralSurfaceKeys = [
  'headerShellClassName',
  'surfaceBarClassName',
  'cardClassName',
  'insetCardClassName',
  'textFieldClassName',
  'compactTextFieldClassName',
  'prominentTextFieldClassName',
  'multilineTextFieldClassName',
  'prominentMultilineTextFieldClassName',
  'searchInlineFieldClassName',
  'composerInlineFieldClassName',
  'segmentedControlClassName',
  'sheetClassName',
  'iconButtonClassName',
  'headerActionClassName',
  'softActionPillClassName',
  'bottomBarClassName',
  'floatingBannerClassName',
  'inlinePillClassName',
  'systemEventPillClassName',
  'chatAssistantBubbleClassName',
  'chatThoughtBubbleClassName',
  'thumbnailSurfaceClassName',
] as const;

function getLayoutTokens(className: string) {
  return className.split(/\s+/).filter((token) => (
    /^(?:-?m[trblxy]?-.+|-?p[trblxy]?-.+|gap(?:-[xy])?-.+|min-[hw]-.+|max-[hw]-.+|[hw]-.+|rounded(?:-.+)?|flex-row|flex-1|items-.+|justify-.+)$/.test(token)
  ));
}

function collectClassNames(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.values(value).flatMap(collectClassNames);
}

function getActiveBorderWidthTokens(className: string) {
  return className.split(/\s+/).filter((token) => (
    /^(?:[a-z-]+:)*(?:border|border-[trblxy])$/.test(token)
  ));
}

function getNumericOpacityModifierKeys(className: string) {
  return [...className.matchAll(/\/(\d+)(?=\s|$)/g)].map((match) => match[1]);
}

function getFirstBaseBackgroundOpacity(className: string) {
  return className.match(/(?:^|\s)bg-[^\s/]+\/(\d+)(?=\s|$)/)?.[1];
}

function getFirstDarkBackgroundOpacity(className: string) {
  return className.match(/(?:^|\s)dark:bg-[^\s/]+\/(\d+)(?=\s|$)/)?.[1];
}

function getSupportedOpacityKeys() {
  return new Set([
    ...defaultTailwindOpacityKeys,
    ...Object.keys(tailwindConfig.theme?.extend?.opacity ?? {}),
  ]);
}

describe('themeTokens', () => {
  it('keeps glass shared-surface layout and shape tokens aligned with default', () => {
    const standard = getThemeAppearance('default', 'light').classNames;
    const glass = getThemeAppearance('glass', 'light').classNames;

    for (const key of layoutClassKeys) {
      expect(getLayoutTokens(glass[key])).toEqual(getLayoutTokens(standard[key]));
    }
  });

  it('adds glass-only frosted surface treatments without changing layout', () => {
    const glass = getThemeAppearance('glass', 'light');

    expect(glass.surfaceKind).toBe('glass');
    expect(glass.effects.surfaceBlurIntensity).toBeGreaterThan(0);
    expect(glass.effects.blurReductionFactor).toBe(1);
    expect(glass.classNames.cardClassName).toContain('bg-background-0/15');
    expect(glass.classNames.cardClassName).not.toContain('shadow-sm');
    expect(glass.classNames.sheetClassName).toContain('bg-background-0/15');
    expect(glass.effects.tabBarStyle).toMatchObject({ elevation: 0, shadowOpacity: 0 });
  });

  it('keeps glass opacity modifiers in the configured Tailwind scale', () => {
    const lightGlass = getThemeAppearance('glass', 'light').classNames;
    const darkGlass = getThemeAppearance('glass', 'dark').classNames;
    const supportedOpacityKeys = getSupportedOpacityKeys();
    const unsupportedOpacityKeys = [lightGlass, darkGlass]
      .flatMap(collectClassNames)
      .flatMap(getNumericOpacityModifierKeys)
      .filter((opacityKey, index, allOpacityKeys) => (
        allOpacityKeys.indexOf(opacityKey) === index && !supportedOpacityKeys.has(opacityKey)
      ));

    expect(unsupportedOpacityKeys).toEqual([]);
  });

  it('keeps dark glass neutral surfaces on clean translucent highlights instead of muddy slate fills', () => {
    const darkGlass = getThemeAppearance('glass', 'dark').classNames;
    const darkGlassColors = getThemeColors('dark', 'glass');

    for (const key of darkGlassNeutralSurfaceKeys) {
      expect(darkGlass[key]).toMatch(/(?:^|\s)(?:dark:)?bg-background-0\//);
      expect(darkGlass[key]).not.toMatch(/dark:bg-background-(?:800|900|950)/);

      const baseOpacity = getFirstBaseBackgroundOpacity(darkGlass[key]);
      const darkOpacity = getFirstDarkBackgroundOpacity(darkGlass[key]);
      if (baseOpacity && darkOpacity) {
        expect(darkOpacity).toBe(baseOpacity);
      }
    }

    expect(darkGlass.toneClassNameByTone.neutral.progressTrackClassName).toContain('bg-background-200/70');
    expect(darkGlass.toneClassNameByTone.neutral.progressTrackClassName).toContain('dark:bg-background-0/70');
    expect(darkGlass.toneClassNameByTone.warning.surfaceClassName).toContain('bg-warning-50/20');
    expect(darkGlass.toneClassNameByTone.warning.surfaceClassName).toContain('dark:bg-warning-500/20');
    expect(darkGlassColors.textSecondary).toBe('#c9d5e7');
    expect(darkGlassColors.textTertiary).toBe('#a9b9cf');
    expect(darkGlassColors.cardBackground).toBe('rgba(244, 247, 251, 0.18)');
    expect(darkGlassColors.tabBarBackground).toBe('rgba(244, 247, 251, 0.2)');
    expect(darkGlassColors.borderSubtle).toBe('rgba(244, 247, 251, 0.38)');
  });

  it('keeps glass tokens from emitting active border widths that can fall back to black', () => {
    const lightGlass = getThemeAppearance('glass', 'light').classNames;
    const darkGlass = getThemeAppearance('glass', 'dark').classNames;
    const allActiveBorderWidthTokens = [lightGlass, darkGlass]
      .flatMap(collectClassNames)
      .flatMap(getActiveBorderWidthTokens);

    expect(allActiveBorderWidthTokens).toEqual([]);
    expect(lightGlass.headerBorderClassName).toContain('border-transparent');
    expect(lightGlass.dividerClassName).toContain('border-transparent');
    expect(darkGlass.headerBorderClassName).toContain('border-transparent');
    expect(darkGlass.dividerClassName).toContain('border-transparent');
  });

  it('keeps parsed Tailwind radius tokens aligned with the NativeWind preset scale used by glass chrome', () => {
    expect(tailwindRadiusPxByToken).toMatchObject({
      DEFAULT: 4,
      lg: 8,
      xl: 12,
      full: 9999,
    });
  });
});
