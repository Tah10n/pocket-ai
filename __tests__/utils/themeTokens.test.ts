import { getThemeAppearance } from '../../src/utils/themeTokens';

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

function getLayoutTokens(className: string) {
  return className.split(/\s+/).filter((token) => (
    /^(?:-?m[trblxy]?-.+|-?p[trblxy]?-.+|gap(?:-[xy])?-.+|min-[hw]-.+|max-[hw]-.+|[hw]-.+|rounded(?:-.+)?|flex-row|flex-1|items-.+|justify-.+)$/.test(token)
  ));
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
    expect(glass.effects.blurReductionFactor).toBe(3);
    expect(glass.classNames.cardClassName).toContain('bg-background-0/72');
    expect(glass.classNames.cardClassName).toContain('shadow-sm');
    expect(glass.classNames.sheetClassName).toContain('bg-background-0/55');
  });
});
