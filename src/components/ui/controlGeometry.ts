import type { ViewStyle } from 'react-native';
import type { MaterialShape } from '../../design-system/materials/contract';

type GeometryRecipe = Readonly<{
  shape: MaterialShape;
  style: Readonly<ViewStyle>;
}>;

export const buttonGeometryBySize = {
  xs: { shape: 'sm', style: { minHeight: 32, paddingHorizontal: 12, paddingVertical: 6 } },
  sm: { shape: 'md', style: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 8 } },
  md: { shape: 'md', style: { minHeight: 40, paddingHorizontal: 16, paddingVertical: 10 } },
  lg: { shape: 'xl', style: { minHeight: 44, paddingHorizontal: 20, paddingVertical: 12 } },
} as const satisfies Record<'xs' | 'sm' | 'md' | 'lg', GeometryRecipe>;

export const screenActionPillGeometryBySize = {
  sm: { shape: 'md', style: { minHeight: 32, paddingHorizontal: 12, paddingVertical: 4 } },
  md: { shape: 'full', style: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 6 } },
  lg: { shape: 'full', style: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12 } },
} as const satisfies Record<'sm' | 'md' | 'lg', GeometryRecipe>;

export const screenTextFieldGeometryBySize = {
  compact: { shape: 'md', style: { minHeight: 44, paddingHorizontal: 12 } },
  default: { shape: 'md', style: { minHeight: 48, paddingHorizontal: 14 } },
  prominent: { shape: 'xl', style: { minHeight: 56, paddingHorizontal: 16, justifyContent: 'center' } },
  multiline: { shape: 'xl', style: { minHeight: 160, paddingHorizontal: 0 } },
  prominentMultiline: { shape: 'xl', style: { minHeight: 320, paddingHorizontal: 0 } },
} as const satisfies Record<
  'compact' | 'default' | 'prominent' | 'multiline' | 'prominentMultiline',
  GeometryRecipe
>;

export const screenInlineInputGeometryByVariant = {
  search: {
    shape: 'md',
    style: { height: 40, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
  },
  composer: {
    shape: 'full',
    style: { height: 40, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  },
} as const satisfies Record<'search' | 'composer', GeometryRecipe>;

export const segmentedControlGeometry = {
  container: { padding: 4, flexDirection: 'row' } as const satisfies Readonly<ViewStyle>,
  item: {
    minHeight: 36,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
  } as const satisfies Readonly<ViewStyle>,
};

export const valueSelectorRowGeometryByDensity = {
  default: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10 },
  compact: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 6 },
} as const satisfies Record<'default' | 'compact', Readonly<ViewStyle>>;
