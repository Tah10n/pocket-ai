jest.mock('nativewind', () => ({
  cssInterop: (component: unknown) => component,
}));

import { composeTextRole, textRoleClassNames } from '../../../src/components/ui/text';

describe('textRoleClassNames', () => {
  it('keeps eyebrow labels compact for badge-sized text', () => {
    expect(textRoleClassNames.eyebrow).toContain('tracking-wide');
    expect(textRoleClassNames.eyebrow).not.toContain('tracking-[0.18em]');
    expect(composeTextRole('eyebrow')).toContain('uppercase');
  });
});
