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
import { getMaterialFrameStyle } from './style';

type BoxProps = React.ComponentProps<typeof Box>;
type BaseMaterialSurfaceProps = {
  readonly material: MaterialRequest;
  readonly shape?: MaterialShape;
};

export type SurfaceProps = BoxProps & BaseMaterialSurfaceProps;

type BasePressableProps = React.ComponentProps<typeof Pressable>;
export type PressableSurfaceProps = BasePressableProps & BaseMaterialSurfaceProps;

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

    return getMaterialFrameStyle(recipe, shape);
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
