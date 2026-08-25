package com.github.tah10n.pocketliquidglass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** minSdk-safe host. API 33 graphics types live in PocketLiquidGlassRendererApi33. */
class PocketLiquidGlassSurface(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val density = resources.displayMetrics.density
  private val fallbackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val fallbackBorderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val shapePath = Path()
  private val shapeRadii = FloatArray(8)
  private var shapeDirty = true
  private var systemEffectsEnabled = true
  private var pressedAmount = 0f
  private var renderer: PocketLiquidGlassRenderer? = null
  private var recordedProvider: PocketLiquidGlassBackdropProvider? = null
  private var consecutiveFailures = 0
  private var retryScheduled = false

  var cornerRadiusTopLeftDp: Float = 0f
    set(value) { field = value; invalidateShape() }
  var cornerRadiusTopRightDp: Float = 0f
    set(value) { field = value; invalidateShape() }
  var cornerRadiusBottomRightDp: Float = 0f
    set(value) { field = value; invalidateShape() }
  var cornerRadiusBottomLeftDp: Float = 0f
    set(value) { field = value; invalidateShape() }
  var isDarkMaterial: Boolean = false
    set(value) { field = value; invalidateMaterial() }
  var materialTintColor: Int = Color.rgb(59, 130, 246)
    set(value) { field = value; invalidateMaterial() }
  var materialTintOpacity: Float = 0f
    set(value) { field = value.coerceIn(0f, 1f); invalidateMaterial() }
  var fallbackColor: Int = Color.TRANSPARENT
    set(value) { field = value; invalidate() }
  var fallbackOpacity: Float = 1f
    set(value) { field = value.coerceIn(0f, 1f); invalidate() }
  var fallbackBorderColor: Int = Color.TRANSPARENT
    set(value) { field = value; invalidate() }
  var fallbackBorderOpacity: Float = 1f
    set(value) { field = value.coerceIn(0f, 1f); invalidate() }
  var fallbackBorderWidthDp: Float = 0f
    set(value) { field = value.coerceAtLeast(0f); invalidate() }
  var isInteractiveMaterial: Boolean = false
    set(value) { field = value; invalidateMaterial() }
  var isMaterialPressed: Boolean = false
    set(value) {
      field = value
      pressedAmount = if (isInteractiveMaterial && value) 1f else 0f
      renderer?.invalidateMaterial()
      invalidate()
    }
  var effectsEnabled: Boolean = true
    set(value) { field = value; invalidateMaterial() }

  init { setWillNotDraw(false) }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    refreshSystemEffectsEnabled()
    resetRendererFailure()
    PocketLiquidGlassBackdropRegistry.register(this)
    invalidate()
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    if (hasWindowFocus) {
      refreshSystemEffectsEnabled()
      resetRendererFailure()
    }
  }

  override fun onDetachedFromWindow() {
    PocketLiquidGlassBackdropRegistry.unregister(this)
    renderer?.dispose()
    renderer = null
    recordedProvider = null
    retryScheduled = false
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    shapeDirty = true
    renderer?.invalidateMaterial()
  }

  override fun dispatchDraw(canvas: Canvas) {
    if (PocketLiquidGlassCapturePass.active) return
    val provider = findProvider()
    if (recordedProvider !== provider) {
      recordedProvider = provider
      resetRendererFailure()
    }
    val canRender = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
      && effectsEnabled && systemEffectsEnabled && canvas.isHardwareAccelerated
      && provider?.hasRecordedScene == true && consecutiveFailures < MAX_RENDER_ATTEMPTS
    val rendered = if (canRender) {
      val activeRenderer = renderer ?: PocketLiquidGlassRendererFactory.create().also { renderer = it }
      activeRenderer.draw(canvas, requireNotNull(provider), this, getShapePath(), pressedAmount)
    } else false
    if (!rendered) {
      drawSemanticFallback(canvas)
      if (canRender) scheduleBoundedRetry()
    } else {
      consecutiveFailures = 0
    }
    super.dispatchDraw(canvas)
  }

  internal fun onBackdropProviderChanged() {
    recordedProvider = null
    resetRendererFailure()
    renderer?.invalidateMaterial()
    postInvalidateOnAnimation()
  }

  private fun findProvider(): PocketLiquidGlassBackdropProvider? {
    var candidate = parent
    while (candidate != null) {
      if (candidate is PocketLiquidGlassBackdropProvider) {
        return candidate.takeIf { it.isProviderActive && it.hasRecordedScene }
      }
      candidate = candidate.parent
    }
    return PocketLiquidGlassBackdropRegistry.current()
  }

  private fun scheduleBoundedRetry() {
    if (retryScheduled || consecutiveFailures >= MAX_RENDER_ATTEMPTS) return
    consecutiveFailures += 1
    retryScheduled = true
    postDelayed({
      retryScheduled = false
      if (isAttachedToWindow) postInvalidateOnAnimation()
    }, RETRY_DELAY_MS * consecutiveFailures)
  }

  private fun drawSemanticFallback(canvas: Canvas) {
    fallbackPaint.color = withOpacity(fallbackColor, fallbackOpacity)
    canvas.drawPath(getShapePath(), fallbackPaint)
    if (fallbackBorderWidthDp > 0f && fallbackBorderOpacity > 0f) {
      fallbackBorderPaint.color = withOpacity(fallbackBorderColor, fallbackBorderOpacity)
      fallbackBorderPaint.strokeWidth = fallbackBorderWidthDp * density
      canvas.drawPath(getShapePath(), fallbackBorderPaint)
    }
  }

  private fun withOpacity(color: Int, opacity: Float): Int = Color.argb(
    (Color.alpha(color) * opacity).toInt().coerceIn(0, 255),
    Color.red(color), Color.green(color), Color.blue(color),
  )

  private fun invalidateShape() { shapeDirty = true; invalidateMaterial() }

  private fun getShapePath(): Path {
    if (!shapeDirty) return shapePath
    val radii = floatArrayOf(
      cornerRadiusTopLeftDp * density, cornerRadiusTopLeftDp * density,
      cornerRadiusTopRightDp * density, cornerRadiusTopRightDp * density,
      cornerRadiusBottomRightDp * density, cornerRadiusBottomRightDp * density,
      cornerRadiusBottomLeftDp * density, cornerRadiusBottomLeftDp * density,
    )
    radii.copyInto(shapeRadii)
    shapePath.reset()
    shapePath.addRoundRect(0f, 0f, width.toFloat(), height.toFloat(), shapeRadii, Path.Direction.CW)
    shapeDirty = false
    return shapePath
  }

  private fun invalidateMaterial() {
    resetRendererFailure()
    renderer?.invalidateMaterial()
    invalidate()
  }

  private fun resetRendererFailure() { consecutiveFailures = 0; retryScheduled = false }

  private fun refreshSystemEffectsEnabled() {
    val nextValue = try {
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    } catch (_: Throwable) { true }
    if (systemEffectsEnabled != nextValue) { systemEffectsEnabled = nextValue; invalidateMaterial() }
  }

  internal companion object {
    internal const val MAX_RENDER_ATTEMPTS = 3
    private const val RETRY_DELAY_MS = 32L
  }
}
