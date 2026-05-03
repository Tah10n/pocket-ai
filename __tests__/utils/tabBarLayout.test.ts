import { bottomTabBarMetrics, createBottomTabBarStyle, isFloatingTabBar } from '../../src/utils/tabBarLayout';

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
    expect(style.position).toBeUndefined();
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
    });

    expect(style.backgroundColor).toBe('transparent');
    expect(style).toMatchObject({
      position: 'absolute',
      left: bottomTabBarMetrics.floatingHorizontalInset,
      right: bottomTabBarMetrics.floatingHorizontalInset,
      bottom: bottomTabBarMetrics.floatingBottomGap,
      borderRadius: bottomTabBarMetrics.glassRadius,
      height: bottomTabBarMetrics.glassHeight,
    });
  });

  it('lets the glass tabBarBackground own the fill for legacy Android too', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android', {
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
    expect(style.borderTopWidth).toBe(0);
    expect(style).toMatchObject({
      position: 'absolute',
      left: bottomTabBarMetrics.floatingHorizontalInset,
      right: bottomTabBarMetrics.floatingHorizontalInset,
      bottom: bottomTabBarMetrics.floatingBottomGap,
      height: bottomTabBarMetrics.glassHeight,
    });
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

  it('detects only glass tab bars as floating', () => {
    expect(isFloatingTabBar({ surfaceKind: 'glass' })).toBe(true);
    expect(isFloatingTabBar({ surfaceKind: 'solid' })).toBe(false);
    expect(isFloatingTabBar()).toBe(false);
  });

});
