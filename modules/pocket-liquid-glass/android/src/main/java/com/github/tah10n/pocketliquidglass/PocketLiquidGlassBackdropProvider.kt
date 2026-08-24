package com.github.tah10n.pocketliquidglass

import android.content.Context
import android.graphics.Canvas
import android.os.Build
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** minSdk-safe owner of the scene. API-specific recording is delegated. */
class PocketLiquidGlassBackdropProvider(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val sceneContainer = FrameLayout(context)
  private var recorder: PocketLiquidGlassSceneRecorder? = null
  private var recorderGeneration = 0L
  private var consecutiveCaptureFailures = 0
  private var captureRetryScheduled = false
  private val captureRetry = Runnable {
    captureRetryScheduled = false
    if (isAttachedToWindow && isProviderActive && consecutiveCaptureFailures < MAX_CAPTURE_ATTEMPTS) {
      invalidate()
    }
  }

  internal val hasRecordedScene: Boolean
    get() = recorder?.ready == true

  internal val recordedSceneGeneration: Long
    get() = recorderGeneration

  var isProviderActive: Boolean = true
    set(value) {
      if (field == value) return
      field = value
      if (value) resetCaptureFailure()
      updateRegistration()
      invalidate()
    }

  init {
    super.addView(sceneContainer, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    resetCaptureFailure()
    updateRegistration()
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    if (hasWindowFocus) resetCaptureFailure()
  }

  override fun onDetachedFromWindow() {
    PocketLiquidGlassBackdropRegistry.deactivate(this)
    removeCallbacks(captureRetry)
    captureRetryScheduled = false
    recorder?.let { runCatching { it.dispose() } }
    recorder = null
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width != oldWidth || height != oldHeight) {
      recorder?.let { runCatching { it.dispose() } }
      recorder = null
      resetCaptureFailure()
    }
  }

  override fun dispatchDraw(canvas: Canvas) {
    // Complete the visible hardware pass first. Apart from keeping chrome
    // responsive, this builds descendant display lists before the software
    // capture skips effect subtrees. Glass uses the resulting scene on the
    // next invalidation, avoiding recursive native scene links and live-tree
    // mutations at the cost of one frame of scene latency.
    super.dispatchDraw(canvas)
    if (
      isProviderActive && canvas.isHardwareAccelerated
      && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
      && consecutiveCaptureFailures < MAX_CAPTURE_ATTEMPTS
    ) {
      try {
        val activeRecorder = recorder ?: PocketLiquidGlassSceneRecorderFactory.create().also {
          recorder = it
          recorderGeneration += 1
        }
        val wasReady = activeRecorder.ready
        activeRecorder.capture(sceneContainer)
        consecutiveCaptureFailures = 0
        if (!wasReady && activeRecorder.ready) PocketLiquidGlassBackdropRegistry.notifySceneUpdated()
      } catch (_: Throwable) {
        recorder?.let { runCatching { it.dispose() } }
        recorder = null
        consecutiveCaptureFailures += 1
        scheduleCaptureRetry()
      }
    }
  }

  internal fun drawRecordedScene(canvas: Canvas) {
    recorder?.draw(canvas)
  }

  override fun addView(child: View?) {
    if (child === sceneContainer) super.addView(child) else sceneContainer.addView(child)
  }
  override fun addView(child: View?, index: Int) {
    if (child === sceneContainer) super.addView(child, index) else sceneContainer.addView(child, index)
  }
  override fun addView(child: View?, params: ViewGroup.LayoutParams?) {
    if (child === sceneContainer) super.addView(child, toHostLayoutParams(params)) else sceneContainer.addView(child, params)
  }
  override fun addView(child: View?, index: Int, params: ViewGroup.LayoutParams?) {
    if (child === sceneContainer) super.addView(child, index, toHostLayoutParams(params)) else sceneContainer.addView(child, index, params)
  }
  override fun addView(child: View?, width: Int, height: Int) {
    if (child === sceneContainer) super.addView(child, width, height) else sceneContainer.addView(child, width, height)
  }
  override fun updateViewLayout(view: View?, params: ViewGroup.LayoutParams?) {
    if (view === sceneContainer) super.updateViewLayout(view, toHostLayoutParams(params)) else sceneContainer.updateViewLayout(view, params)
  }
  override fun removeView(view: View?) {
    if (view === sceneContainer) super.removeView(view) else sceneContainer.removeView(view)
  }
  override fun removeViewAt(index: Int) = sceneContainer.removeViewAt(index)
  override fun removeViews(start: Int, count: Int) = sceneContainer.removeViews(start, count)
  override fun removeViewsInLayout(start: Int, count: Int) = sceneContainer.removeViewsInLayout(start, count)
  override fun removeAllViews() = sceneContainer.removeAllViews()
  override fun removeAllViewsInLayout() = sceneContainer.removeAllViewsInLayout()
  override fun getChildCount(): Int = sceneContainer.childCount
  override fun getChildAt(index: Int): View? = sceneContainer.getChildAt(index)
  override fun indexOfChild(child: View?): Int = sceneContainer.indexOfChild(child)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val measuredWidth = MeasureSpec.getSize(widthMeasureSpec)
    val measuredHeight = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(measuredWidth, measuredHeight)
    sceneContainer.measure(
      MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    sceneContainer.layout(0, 0, right - left, bottom - top)
  }

  private fun updateRegistration() {
    if (isProviderActive && isAttachedToWindow) PocketLiquidGlassBackdropRegistry.activate(this)
    else PocketLiquidGlassBackdropRegistry.deactivate(this)
  }

  private fun scheduleCaptureRetry() {
    if (captureRetryScheduled || consecutiveCaptureFailures >= MAX_CAPTURE_ATTEMPTS) return
    captureRetryScheduled = true
    postDelayed(captureRetry, RETRY_DELAY_MS * consecutiveCaptureFailures)
  }

  private fun resetCaptureFailure() {
    removeCallbacks(captureRetry)
    consecutiveCaptureFailures = 0
    captureRetryScheduled = false
    invalidate()
  }

  private fun toHostLayoutParams(params: ViewGroup.LayoutParams?): LayoutParams = when (params) {
    null -> LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    is LayoutParams -> params
    else -> LayoutParams(params)
  }

  internal companion object {
    internal const val MAX_CAPTURE_ATTEMPTS = 3
    private const val RETRY_DELAY_MS = 32L
  }
}
