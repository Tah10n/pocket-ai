import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { MaterialEnvironmentProvider } from '../../src/design-system/materials/MaterialEnvironmentProvider';
import { PressableSurface, Surface } from '../../src/design-system/materials/Surface';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import { semanticColorTokens, withAlpha } from '../../src/design-system/themes/legacyTheme';
import { resolveTheme } from '../../src/design-system/themes/resolver';

let mockResolvedTheme = resolveTheme('glass', 'light');

const defaultFrameCases: readonly {
  readonly mode: 'light' | 'dark';
  readonly variant: 'raised' | 'inset';
  readonly fillColor: string;
  readonly rimColor: string;
}[] = [
  {
    mode: 'light',
    variant: 'raised',
    fillColor: semanticColorTokens.background[50],
    rimColor: semanticColorTokens.outline[200],
  },
  {
    mode: 'light',
    variant: 'inset',
    fillColor: semanticColorTokens.background[0],
    rimColor: semanticColorTokens.outline[200],
  },
  {
    mode: 'dark',
    variant: 'raised',
    fillColor: withAlpha(semanticColorTokens.background[900], 0.6),
    rimColor: semanticColorTokens.outline[800],
  },
  {
    mode: 'dark',
    variant: 'inset',
    fillColor: withAlpha(semanticColorTokens.background[950], 0.7),
    rimColor: semanticColorTokens.outline[700],
  },
];

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

describe('material Surface primitives', () => {
  beforeEach(() => {
    mockResolvedTheme = resolveTheme('glass', 'light');
  });

  it('renders content as a dense host even when live iOS effects are available', () => {
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <Surface
          testID="content-surface"
          material={{ role: 'content', variant: 'raised' }}
          shape="lg"
        >
          content
        </Surface>
      </MaterialEnvironmentProvider>,
    );

    expect(StyleSheet.flatten(screen.getByTestId('content-surface').props.style)).toMatchObject({
      backgroundColor: mockResolvedTheme.colors.cardBackground,
      borderColor: mockResolvedTheme.colors.borderSubtle,
      borderRadius: 20,
      borderWidth: 1,
    });
    expect(screen.toJSON()).toMatchObject({ type: 'View' });
  });

  it('maps semantic tones and explicit shapes without parsing class names', () => {
    mockResolvedTheme = resolveTheme('default', 'dark');
    const screen = render(
      <Surface
        testID="warning-surface"
        material={{ role: 'content', variant: 'inset', tone: 'warning' }}
        shape="sheet"
        className="rounded-full"
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('warning-surface').props.style)).toMatchObject({
      backgroundColor: withAlpha(semanticColorTokens.warning[950], 0.35),
      borderColor: semanticColorTokens.warning[800],
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    });
    expect(StyleSheet.flatten(screen.getByTestId('warning-surface').props.style).borderRadius)
      .toBeUndefined();
  });

  it.each(defaultFrameCases)(
    'preserves the default $mode $variant card frame in the material recipe',
    ({ mode, variant, fillColor, rimColor }) => {
    mockResolvedTheme = resolveTheme('default', mode);
    const screen = render(
      <Surface
        testID="default-raised-surface"
        material={{ role: 'content', variant }}
        shape={variant === 'raised' ? 'lg' : 'md'}
      />,
    );

    expect(StyleSheet.flatten(screen.getByTestId('default-raised-surface').props.style)).toMatchObject({
      backgroundColor: fillColor,
      borderColor: rimColor,
      borderRadius: variant === 'raised' ? 20 : 16,
      borderWidth: 1,
    });
  });

  it.each(['light', 'dark'] as const)(
    'preserves dense default-theme message frames in %s mode',
    (mode) => {
      mockResolvedTheme = resolveTheme('default', mode);
      const user = render(
        <Surface
          testID="user-message-material"
          material={{ role: 'content', variant: 'message', tone: 'primary' }}
          shape="lg"
        />,
      );
      const assistant = render(
        <Surface
          testID="assistant-message-material"
          material={{ role: 'content', variant: 'message' }}
          shape="lg"
        />,
      );
      const thought = render(
        <Surface
          testID="message-thought-material"
          material={{ role: 'content', variant: 'messageThought' }}
        />,
      );
      const attachment = render(
        <Surface
          testID="message-attachment-material"
          material={{ role: 'content', variant: 'messageAttachment' }}
        />,
      );
      const inlineError = render(
        <Surface
          testID="message-error-material"
          material={{ role: 'content', variant: 'messageError' }}
        />,
      );

      expect(StyleSheet.flatten(user.getByTestId('user-message-material').props.style)).toMatchObject({
        backgroundColor: mockResolvedTheme.colors.primary,
        borderWidth: 0,
      });
      expect(StyleSheet.flatten(assistant.getByTestId('assistant-message-material').props.style)).toMatchObject({
        backgroundColor: mode === 'dark'
          ? withAlpha(semanticColorTokens.background[900], 0.7)
          : semanticColorTokens.background[50],
        borderColor: mode === 'dark'
          ? semanticColorTokens.outline[800]
          : semanticColorTokens.outline[200],
        borderWidth: 1,
      });
      expect(StyleSheet.flatten(thought.getByTestId('message-thought-material').props.style)).toMatchObject({
        backgroundColor: withAlpha(
          mode === 'dark' ? semanticColorTokens.background[950] : semanticColorTokens.background[0],
          mode === 'dark' ? 0.4 : 0.8,
        ),
        borderColor: withAlpha(
          mode === 'dark' ? semanticColorTokens.outline[700] : semanticColorTokens.outline[200],
          mode === 'dark' ? 0.7 : 0.8,
        ),
        borderWidth: 1,
      });
      expect(StyleSheet.flatten(attachment.getByTestId('message-attachment-material').props.style)).toMatchObject({
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        borderWidth: 0,
      });
      expect(StyleSheet.flatten(inlineError.getByTestId('message-error-material').props.style)).toMatchObject({
        backgroundColor: withAlpha(semanticColorTokens.error[500], mode === 'dark' ? 0.15 : 0.1),
        borderColor: 'transparent',
        borderWidth: 0,
      });
    },
  );

  it.each(['light', 'dark'] as const)(
    'preserves default-theme composer control frames in %s mode',
    (mode) => {
      mockResolvedTheme = resolveTheme('default', mode);
      const modeBanner = render(
        <Surface
          testID="composer-mode-material"
          material={{ role: 'content', variant: 'composerMode' }}
        />,
      );
      const primaryAction = render(
        <PressableSurface
          testID="composer-primary-action-material"
          material={{ role: 'control', variant: 'selected', tone: 'primary' }}
          shape="full"
        />,
      );

      expect(StyleSheet.flatten(modeBanner.getByTestId('composer-mode-material').props.style)).toMatchObject({
        backgroundColor: withAlpha(semanticColorTokens.primary[500], 0.05),
        borderColor: withAlpha(semanticColorTokens.primary[500], 0.15),
        borderWidth: 1,
      });
      expect(StyleSheet.flatten(primaryAction.getByTestId('composer-primary-action-material').props.style)).toMatchObject({
        backgroundColor: semanticColorTokens.primary[500],
        borderColor: semanticColorTokens.primary[500],
        borderWidth: 0,
      });
    },
  );

  it('forwards host accessibility and pointer event props', () => {
    const screen = render(
      <Surface
        testID="accessible-surface"
        material={{ role: 'content' }}
        accessibilityLabel="Material content"
        pointerEvents="box-none"
      />,
    );

    expect(screen.getByTestId('accessible-surface').props).toMatchObject({
      accessibilityLabel: 'Material content',
      pointerEvents: 'box-none',
    });
  });

  it('composes pressable callback styles after the material frame', () => {
    const pressedStyle = { transform: [{ scale: 0.98 }] };
    const screen = render(
      <PressableSurface
        testID="pressable-surface"
        material={{ role: 'content', variant: 'list' }}
        role="button"
        accessibilityRole="button"
        style={({ pressed }) => (pressed ? pressedStyle : undefined)}
      />,
    );
    const pressable = screen.getByTestId('pressable-surface');
    const resolvedPressedStyle = pressable.props.style({ pressed: true });

    expect(StyleSheet.flatten(resolvedPressedStyle)).toMatchObject({
      backgroundColor: mockResolvedTheme.colors.surfaceMuted,
      borderRadius: 16,
      transform: [{ scale: 0.98 }],
    });
    expect(pressable.props.accessibilityRole).toBe('button');
    expect(pressable.props.role).toBe('button');
  });
});
