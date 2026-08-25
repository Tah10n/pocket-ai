package com.github.tah10n.pocketliquidglass

import android.graphics.Canvas
import android.graphics.Picture
import android.graphics.RenderNode
import android.os.Build
import android.view.View
import androidx.annotation.RequiresApi

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal class PocketLiquidGlassSceneRecorderApi33 : PocketLiquidGlassSceneRecorder {
  private val scenePicture = Picture()
  private val sceneNode = RenderNode("PocketLiquidGlassSharedScene")

  override val ready: Boolean
    get() = sceneNode.hasDisplayList()

  override fun capture(scene: View) {
    if (scene.width <= 0 || scene.height <= 0) return
    val pictureCanvas = scenePicture.beginRecording(scene.width, scene.height)
    try {
      PocketLiquidGlassCapturePass.run { scene.draw(pictureCanvas) }
    } finally {
      scenePicture.endRecording()
    }

    // Recording an attached View tree straight into a hardware RenderNode can
    // retain cached child RenderNodes and form a cycle once glass surfaces draw
    // this shared scene. Picture replays drawing commands without those links.
    sceneNode.setPosition(0, 0, scene.width, scene.height)
    val nodeCanvas = sceneNode.beginRecording(scene.width, scene.height)
    try {
      scenePicture.draw(nodeCanvas)
    } finally {
      sceneNode.endRecording()
    }
  }

  override fun draw(canvas: Canvas) {
    if (sceneNode.hasDisplayList()) canvas.drawRenderNode(sceneNode)
  }

  override fun dispose() {
    sceneNode.discardDisplayList()
  }
}
