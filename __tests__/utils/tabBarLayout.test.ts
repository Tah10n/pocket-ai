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

  it('lets the glass tabBarBackground own the fill when Android blur is supported', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android', 'floating');

    expect(style.backgroundColor).toBe('transparent');
    expect(style).toMatchObject({
      position: 'absolute',
      left: bottomTabBarMetrics.floatingHorizontalInset,
      right: bottomTabBarMetrics.floatingHorizontalInset,
      bottom: bottomTabBarMetrics.floatingBottomGap,
      borderRadius: bottomTabBarMetrics.floatingRadius,
      height: bottomTabBarMetrics.floatingHeight,
    });
  });

  it('lets the glass tabBarBackground own the fill for legacy Android too', () => {
    const style = createBottomTabBarStyle(colors, 0, 'android', 'floating');

    expect(style.backgroundColor).toBe('transparent');
    expect(style.borderTopWidth).toBe(0);
    expect(style).toMatchObject({
      position: 'absolute',
      left: bottomTabBarMetrics.floatingHorizontalInset,
      right: bottomTabBarMetrics.floatingHorizontalInset,
      bottom: bottomTabBarMetrics.floatingBottomGap,
      height: bottomTabBarMetrics.floatingHeight,
    });
  });

  it('lets the glass tabBarBackground own the fill off Android', () => {
    const style = createBottomTabBarStyle(colors, 0, 'ios', 'floating');

    expect(style.backgroundColor).toBe('transparent');
  });

  it('detects only the floating presentation as floating', () => {
    expect(isFloatingTabBar('floating')).toBe(true);
    expect(isFloatingTabBar('attached')).toBe(false);
    expect(isFloatingTabBar()).toBe(false);
  });

});
