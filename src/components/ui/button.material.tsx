import React from 'react';
import {
  type PressableProps,
  type PressableStateCallbackType,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import { PressableSurface } from '../../design-system/materials/Surface';
import type { MaterialRequest, MaterialTone } from '../../design-system/materials/contract';
import type { SemanticForegroundRole } from '../../design-system/themes/foreground';
import { buttonLayoutTokens } from '../../utils/themeTokens';
import { Text, composeTextRole } from './text';
import { buttonGeometryBySize } from './controlGeometry';

interface ButtonProps extends PressableProps {
  action?: 'primary' | 'secondary' | 'positive' | 'negative' | 'default' | 'softPrimary' | 'softDestructive';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  className?: string;
}

type ButtonAction = NonNullable<ButtonProps['action']>;
type ButtonSize = NonNullable<ButtonProps['size']>;

const ButtonContext = React.createContext<{
  colorRole: SemanticForegroundRole;
  size: ButtonSize;
}>({
  colorRole: 'onAccent',
  size: 'md',
});

function getButtonMaterial(action: ButtonAction): MaterialRequest {
  const tone: MaterialTone = action === 'positive'
    ? 'success'
    : action === 'negative' || action === 'softDestructive'
      ? 'error'
      : action === 'primary' || action === 'softPrimary'
        ? 'primary'
        : 'neutral';
  const variant = action === 'primary' || action === 'positive' || action === 'negative'
    ? 'selected'
    : 'inline';

  return { role: 'control', variant, tone };
}

function getButtonForegroundRole(action: ButtonAction): SemanticForegroundRole {
  if (action === 'primary') return 'onAccent';
  if (action === 'positive') return 'onSuccess';
  if (action === 'negative') return 'onError';
  if (action === 'softPrimary') return 'softAction';
  if (action === 'softDestructive') return 'danger';
  return 'primary';
}

export function Button({
  action = 'primary',
  size = 'md',
  className = '',
  children,
  disabled,
  style,
  ...props
}: ButtonProps) {
  const material = React.useMemo(() => getButtonMaterial(action), [action]);
  const colorRole = getButtonForegroundRole(action);
  const geometry = buttonGeometryBySize[size];
  const resolvedStyle = typeof style === 'function'
    ? (state: PressableStateCallbackType): StyleProp<ViewStyle> => [geometry.style, style(state)]
    : [geometry.style, style];

  return (
    <ButtonContext.Provider value={{ colorRole, size }}>
      <PressableSurface
        accessibilityRole={props.accessibilityRole ?? 'button'}
        material={material}
        shape={geometry.shape}
        disabled={disabled}
        className={`flex-row items-center justify-center gap-2 active:opacity-85 ${disabled ? 'opacity-55' : ''} ${className}`.trim()}
        style={resolvedStyle}
        {...props}
      >
        {children}
      </PressableSurface>
    </ButtonContext.Provider>
  );
}

interface ButtonTextProps extends TextProps {
  className?: string;
}

export function ButtonText({ className = '', children, ...props }: ButtonTextProps) {
  const { colorRole, size } = React.useContext(ButtonContext);

  return (
    <Text
      colorRole={colorRole}
      className={`${composeTextRole('action', `${buttonLayoutTokens.textSizeClassNameBySize[size]} text-center`)} ${className}`.trim()}
      {...props}
    >
      {children}
    </Text>
  );
}
