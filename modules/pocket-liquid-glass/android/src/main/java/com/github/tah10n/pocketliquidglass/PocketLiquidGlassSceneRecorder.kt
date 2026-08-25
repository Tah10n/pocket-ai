package com.github.tah10n.pocketliquidglass

import android.graphics.Canvas
import android.os.Build
import android.view.View
import androidx.annotation.RequiresApi

internal interface PocketLiquidGlassSceneRecorder {
  val ready: Boolean
  fun capture(scene: View)
  fun draw(canvas: Canvas)
  fun dispose()
}

internal object PocketLiquidGlassSceneRecorderFactory {
  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  fun create(): PocketLiquidGlassSceneRecorder = PocketLiquidGlassSceneRecorderApi33()
}
