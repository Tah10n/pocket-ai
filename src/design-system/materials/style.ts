import type { ViewStyle } from 'react-native';
import type { MaterialRendererRecipe, MaterialShape } from './contract';

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
  tabBar: { borderRadius: 34 },
  full: { borderRadius: 9999 },
});

export function withMaterialPaintOpacity(color: string, opacity: number): string {
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

export function getMaterialShapeStyle(shape: MaterialShape): ViewStyle {
  return radiusStyleByShape[shape];
}

export function getMaterialFrameStyle(
  recipe: MaterialRendererRecipe,
  shape: MaterialShape,
): ViewStyle {
  const softRim = recipe.softRim;

  return {
    backgroundColor: withMaterialPaintOpacity(recipe.fill.color, recipe.fill.opacity),
    borderColor: withMaterialPaintOpacity(recipe.rim.color, recipe.rim.opacity),
    borderWidth: recipe.rim.width,
    boxShadow: softRim
      ? [{
          blurRadius: softRim.blurRadius,
          color: withMaterialPaintOpacity(softRim.color, softRim.opacity),
          inset: true,
          offsetX: 0,
          offsetY: 0,
          spreadDistance: softRim.spreadDistance,
        }]
      : undefined,
    elevation: recipe.shadow.elevation,
    shadowColor: recipe.shadow.color,
    shadowOffset: {
      width: recipe.shadow.offsetX,
      height: recipe.shadow.offsetY,
    },
    shadowOpacity: recipe.shadow.opacity,
    shadowRadius: recipe.shadow.radius,
    ...getMaterialShapeStyle(shape),
  };
}
