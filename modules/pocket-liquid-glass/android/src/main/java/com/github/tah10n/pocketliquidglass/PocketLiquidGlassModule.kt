package com.github.tah10n.pocketliquidglass

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PocketLiquidGlassModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PocketLiquidGlass")

    Function("isRuntimeShaderSupported") {
      resolveNativeGlassRenderer(
        apiLevel = Build.VERSION.SDK_INT,
        effectsEnabled = true,
        runtimeShaderAvailable = true,
        rendererFailed = false,
      ) == NativeGlassRenderer.LIQUID_GLASS
    }

    View(PocketLiquidGlassBackdropProvider::class) {
      Prop("active") { view: PocketLiquidGlassBackdropProvider, active: Boolean ->
        view.isProviderActive = active
      }
      Prop("sceneRevision") { view: PocketLiquidGlassBackdropProvider, revision: String ->
        view.sceneRevision = revision
      }
    }

    View(PocketLiquidGlassSurface::class) {
      Prop("cornerRadiusTopLeft") { view: PocketLiquidGlassSurface, radius: Float -> view.cornerRadiusTopLeftDp = radius.coerceAtLeast(0f) }
      Prop("cornerRadiusTopRight") { view: PocketLiquidGlassSurface, radius: Float -> view.cornerRadiusTopRightDp = radius.coerceAtLeast(0f) }
      Prop("cornerRadiusBottomRight") { view: PocketLiquidGlassSurface, radius: Float -> view.cornerRadiusBottomRightDp = radius.coerceAtLeast(0f) }
      Prop("cornerRadiusBottomLeft") { view: PocketLiquidGlassSurface, radius: Float -> view.cornerRadiusBottomLeftDp = radius.coerceAtLeast(0f) }
      Prop("dark") { view: PocketLiquidGlassSurface, dark: Boolean ->
        view.isDarkMaterial = dark
      }
      Prop("tintColor") { view: PocketLiquidGlassSurface, color: Int ->
        view.materialTintColor = color
      }
      Prop("tintOpacity") { view: PocketLiquidGlassSurface, opacity: Float ->
        view.materialTintOpacity = opacity
      }
      Prop("fallbackColor") { view: PocketLiquidGlassSurface, color: Int ->
        view.fallbackColor = color
      }
      Prop("fallbackOpacity") { view: PocketLiquidGlassSurface, opacity: Float ->
        view.fallbackOpacity = opacity
      }
      Prop("fallbackBorderColor") { view: PocketLiquidGlassSurface, color: Int ->
        view.fallbackBorderColor = color
      }
      Prop("fallbackBorderOpacity") { view: PocketLiquidGlassSurface, opacity: Float ->
        view.fallbackBorderOpacity = opacity
      }
      Prop("fallbackBorderWidth") { view: PocketLiquidGlassSurface, width: Float ->
        view.fallbackBorderWidthDp = width
      }
      Prop("interactive") { view: PocketLiquidGlassSurface, interactive: Boolean ->
        view.isInteractiveMaterial = interactive
      }
      Prop("pressed") { view: PocketLiquidGlassSurface, pressed: Boolean ->
        view.isMaterialPressed = pressed
      }
      Prop("effectsEnabled") { view: PocketLiquidGlassSurface, enabled: Boolean ->
        view.effectsEnabled = enabled
      }
    }

    View(PocketLiquidGlassCaptureExclusion::class) {}
  }
}
