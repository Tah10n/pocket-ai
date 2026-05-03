import { getNativeBottomSafeAreaInset } from '../../src/utils/safeArea';

describe('safeArea utilities', () => {
  it('uses the Android bottom inset for system navigation space', () => {
    expect(getNativeBottomSafeAreaInset(48, 'android')).toBe(48);
  });

  it('uses the iOS bottom inset for home indicator space', () => {
    expect(getNativeBottomSafeAreaInset(34, 'ios')).toBe(34);
  });

  it('clamps invalid native inset values', () => {
    expect(getNativeBottomSafeAreaInset(-12, 'android')).toBe(0);
    expect(getNativeBottomSafeAreaInset(Number.NaN, 'ios')).toBe(0);
  });
});
