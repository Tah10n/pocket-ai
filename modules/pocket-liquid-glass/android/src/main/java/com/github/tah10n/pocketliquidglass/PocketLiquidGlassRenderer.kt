package com.github.tah10n.pocketliquidglass

import android.graphics.Canvas
import android.graphics.Path
import android.os.Build
import androidx.annotation.RequiresApi

internal interface PocketLiquidGlassRenderer {
  fun draw(canvas: Canvas, provider: PocketLiquidGlassBackdropProvider, surface: PocketLiquidGlassSurface, shapePath: Path, pressedAmount: Float): Boolean
  fun invalidateMaterial()
  fun dispose()
}

internal object PocketLiquidGlassRendererFactory {
  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  fun create(): PocketLiquidGlassRenderer = PocketLiquidGlassRendererApi33()
}
