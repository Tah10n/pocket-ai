import type {
  MaterialEnvironment,
  MaterialRecipeDefinition,
  MaterialRendererRecipe,
  MaterialRequest,
  MaterialTone,
  MaterialToneRecipes,
  ThemeMaterialRecipes,
} from './contract';

function getRequestedRecipes(
  materials: ThemeMaterialRecipes,
  request: MaterialRequest,
): MaterialToneRecipes {
  switch (request.role) {
    case 'canvas':
      return materials.canvas[request.variant ?? 'base'];
    case 'content':
      return materials.content[request.variant ?? 'raised'];
    case 'chrome':
      return materials.chrome[request.variant ?? 'header'];
    case 'control':
      return materials.control[request.variant ?? 'inline'];
    case 'overlay':
      return materials.overlay[request.variant ?? 'banner'];
  }
}

function getToneRecipe(
  recipes: MaterialToneRecipes,
  tone: MaterialTone = 'neutral',
): MaterialRecipeDefinition {
  return recipes[tone] ?? recipes.neutral;
}

function isEffectRecipe(recipe: MaterialRendererRecipe): boolean {
  return recipe.renderer === 'blur' || recipe.renderer === 'native-liquid-glass';
}

function isRecipeSupported(
  recipe: MaterialRendererRecipe,
  environment: MaterialEnvironment,
): boolean {
  if (recipe.renderer === 'solid' || recipe.renderer === 'tinted') {
    return true;
  }

  if (recipe.renderer === 'native-liquid-glass') {
    return environment.platform === 'ios'
      && environment.liquidGlassComponentAvailable
      && environment.liquidGlassApiAvailable;
  }

  if (environment.platform === 'ios') {
    return environment.blurViewAvailable;
  }

  if (environment.platform === 'android') {
    return (environment.androidSdkVersion ?? 0) >= 31
      && environment.androidTargetBlurSupported;
  }

  return false;
}

function resolveDefinition(
  definition: MaterialRecipeDefinition,
  environment: MaterialEnvironment,
): MaterialRendererRecipe {
  const preferred = definition.preferredByPlatform[environment.platform];

  if (isEffectRecipe(preferred) && environment.transparencyState !== 'allowed') {
    return definition.accessibilityFallback;
  }

  if (isRecipeSupported(preferred, environment)) {
    return preferred;
  }

  const platformFallback = definition.platformFallbackByPlatform?.[environment.platform];
  if (platformFallback) {
    if (isEffectRecipe(platformFallback) && environment.transparencyState !== 'allowed') {
      return definition.accessibilityFallback;
    }

    if (isRecipeSupported(platformFallback, environment)) {
      return platformFallback;
    }
  }

  return definition.unsupportedPlatformFallback;
}

export function resolveMaterialRecipe(
  materials: ThemeMaterialRecipes,
  request: MaterialRequest,
  environment: MaterialEnvironment,
): MaterialRendererRecipe {
  return resolveDefinition(
    getToneRecipe(getRequestedRecipes(materials, request), request.tone),
    environment,
  );
}
