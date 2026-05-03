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
});
