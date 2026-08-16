import React from 'react';
import {
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { useTheme } from '../../providers/ThemeProvider';
import type { MaterialRequest, MaterialShape } from './contract';
import { FAIL_CLOSED_MATERIAL_ENVIRONMENT } from './environment';
import { resolveMaterialRecipe } from './resolver';

const radiusStyleByShape: Readonly<Record<MaterialShape, ViewStyle>> = Object.freeze({
  none: { borderRadius: 0 },
  sm: { borderRadius: 12 },
  md: { borderRadius: 16 },
  lg: { borderRadius: 20 },
  xl: { borderRadius: 28 },
  sheet: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
  },
  full: { borderRadius: 9999 },
});

type BoxProps = React.ComponentProps<typeof Box>;
type BaseMaterialSurfaceProps = {
  readonly material: MaterialRequest;
  readonly shape?: MaterialShape;
};

export type SurfaceProps = BoxProps & BaseMaterialSurfaceProps;

type BasePressableProps = React.ComponentProps<typeof Pressable>;
export type PressableSurfaceProps = BasePressableProps & BaseMaterialSurfaceProps;

function withPaintOpacity(color: string, opacity: number): string {
  if (opacity >= 1) {
    return color;
  }

  const normalizedOpacity = Math.max(0, opacity);
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color);
  if (shortHex) {
    const [, red, green, blue] = shortHex;
    return `rgba(${parseInt(red + red, 16)},${parseInt(green + green, 16)},${parseInt(blue + blue, 16)},${normalizedOpacity})`;
  }

  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(color);
  if (hex) {
    return `rgba(${parseInt(hex[1], 16)},${parseInt(hex[2], 16)},${parseInt(hex[3], 16)},${normalizedOpacity})`;
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (rgb) {
    const channels = rgb[1].split(',').slice(0, 3).map((channel) => channel.trim());
    return `rgba(${channels.join(',')},${normalizedOpacity})`;
  }

  return color;
}

function useDenseMaterialStyle(
  request: MaterialRequest,
  shape: MaterialShape,
): ViewStyle {
  const { resolvedTheme } = useTheme();

  return React.useMemo(() => {
    const recipe = resolveMaterialRecipe(
      resolvedTheme.materials,
      request,
      FAIL_CLOSED_MATERIAL_ENVIRONMENT,
    );

    return {
      backgroundColor: withPaintOpacity(recipe.fill.color, recipe.fill.opacity),
      borderColor: withPaintOpacity(recipe.rim.color, recipe.rim.opacity),
      ...radiusStyleByShape[shape],
      borderWidth: recipe.rim.width,
      elevation: recipe.shadow.elevation,
      shadowColor: recipe.shadow.color,
      shadowOffset: {
        width: recipe.shadow.offsetX,
        height: recipe.shadow.offsetY,
      },
      shadowOpacity: recipe.shadow.opacity,
      shadowRadius: recipe.shadow.radius,
    };
  }, [request, resolvedTheme.materials, shape]);
}

export function Surface(surfaceProps: SurfaceProps) {
  const {
    material,
    shape = 'md',
    style,
    ...props
  } = surfaceProps;
  const materialStyle = useDenseMaterialStyle(material, shape);

  return <Box {...props} style={[materialStyle, style]} />;
}

export function PressableSurface(surfaceProps: PressableSurfaceProps) {
  const {
    material,
    shape = 'md',
    style,
    ...props
  } = surfaceProps;
  const materialStyle = useDenseMaterialStyle(material, shape);
  const resolvedStyle = typeof style === 'function'
    ? (state: PressableStateCallbackType): StyleProp<ViewStyle> => [materialStyle, style(state)]
    : [materialStyle, style];

  return <Pressable {...props} style={resolvedStyle} />;
}
