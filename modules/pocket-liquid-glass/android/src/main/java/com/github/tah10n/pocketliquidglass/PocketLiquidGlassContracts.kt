package com.github.tah10n.pocketliquidglass

internal enum class NativeGlassRenderer {
  LIQUID_GLASS,
  FROSTED_BLUR,
  DENSE,
}

internal enum class BackdropSourceRelation {
  SHARED_PROVIDER,
  SELF,
  ANCESTOR,
  DIFFERENT_WINDOW,
  DETACHED,
}

internal fun resolveNativeGlassRenderer(
  apiLevel: Int,
  effectsEnabled: Boolean,
  runtimeShaderAvailable: Boolean,
  rendererFailed: Boolean,
): NativeGlassRenderer = when {
  !effectsEnabled || rendererFailed || apiLevel < 33 -> NativeGlassRenderer.DENSE
  apiLevel >= 33 && runtimeShaderAvailable -> NativeGlassRenderer.LIQUID_GLASS
  else -> NativeGlassRenderer.DENSE
}

internal fun isBackdropSourceAllowed(relation: BackdropSourceRelation): Boolean =
  relation == BackdropSourceRelation.SHARED_PROVIDER ||
    relation == BackdropSourceRelation.DIFFERENT_WINDOW

internal data class BackdropTranslation(val x: Int, val y: Int)

internal fun resolveBackdropTranslation(
  providerX: Int,
  providerY: Int,
  surfaceX: Int,
  surfaceY: Int,
): BackdropTranslation = BackdropTranslation(
  x = providerX - surfaceX,
  y = providerY - surfaceY,
)
