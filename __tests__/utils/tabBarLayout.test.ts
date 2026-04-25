import { bottomTabBarMetrics, createBottomTabBarStyle } from '../../src/utils/tabBarLayout';

const colors = {
  tabBarBackground: '#101828',
  tabBarBorder: '#344054',
};

describe('tabBarLayout', () => {
  it('adds Android system navigation inset to the tab bar height and padding', () => {
    const style = createBottomTabBarStyle(colors, 48, 'android');

    expect(style).toMatchObject({
      height: bottomTabBarMetrics.height + 48,
      paddingBottom: bottomTabBarMetrics.paddingBottom + 48,
      paddingTop: bottomTabBarMetrics.paddingTop,
      backgroundColor: colors.tabBarBackground,
      borderTopColor: colors.tabBarBorder,
    });
  });

  it('adds iOS home indicator inset to the tab bar height and padding', () => {
    const style = createBottomTabBarStyle(colors, 34, 'ios');

    expect(style).toMatchObject({
      height: bottomTabBarMetrics.height + 34,
      paddingBottom: bottomTabBarMetrics.paddingBottom + 34,
    });
  });

  it('keeps the base tab bar size when there is no bottom inset', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android');

    expect(style).toMatchObject({
      height: bottomTabBarMetrics.height,
      paddingBottom: bottomTabBarMetrics.paddingBottom,
    });
  });

  it('merges theme appearance effects into the tab bar style', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android', {
      id: 'glass',
      surfaceKind: 'glass',
      effects: {
        headerBlurIntensity: 96,
        surfaceBlurIntensity: 60,
        blurReductionFactor: 3,
        tabBarStyle: {
          elevation: 8,
          shadowOpacity: 0.2,
          shadowRadius: 18,
        },
      },
    });

    expect(style).toMatchObject({
      elevation: 8,
      shadowOpacity: 0.2,
      shadowRadius: 18,
    });
  });

  it('lets the glass tabBarBackground own the fill when Android blur is supported', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android', {
      id: 'glass',
      surfaceKind: 'glass',
      effects: {
        headerBlurIntensity: 60,
        surfaceBlurIntensity: 55,
        blurReductionFactor: 3,
        tabBarStyle: {},
      },
    }, 34);

    expect(style.backgroundColor).toBe('transparent');
  });

  it('keeps a dense native fallback fill for legacy Android', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android', {
      id: 'glass',
      surfaceKind: 'glass',
      effects: {
        headerBlurIntensity: 60,
        surfaceBlurIntensity: 55,
        blurReductionFactor: 3,
        tabBarStyle: {},
      },
    }, 30);

    expect(style.backgroundColor).toBe(colors.tabBarBackground);
  });

  it('lets the glass tabBarBackground own the fill off Android', () => {
    const style = createBottomTabBarStyle(colors, 0, 'ios', {
      id: 'glass',
      surfaceKind: 'glass',
      effects: {
        headerBlurIntensity: 60,
        surfaceBlurIntensity: 55,
        blurReductionFactor: 3,
        tabBarStyle: {},
      },
    });

    expect(style.backgroundColor).toBe('transparent');
  });

});
