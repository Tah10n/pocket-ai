package com.github.tah10n.pocketliquidglass

import android.content.Context
import android.graphics.Canvas
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/** Keeps sibling chrome out of the recorded scene without changing layout. */
class PocketLiquidGlassCaptureExclusion(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val contentContainer = LayoutPassthroughFrameLayout(context)

  init {
    super.addView(contentContainer, FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun draw(canvas: Canvas) {
    if (PocketLiquidGlassCapturePass.active) return
    super.draw(canvas)
  }

  override fun addView(child: View?) {
    if (child === contentContainer) super.addView(child) else contentContainer.addView(child)
  }
  override fun addView(child: View?, index: Int) {
    if (child === contentContainer) super.addView(child, index) else contentContainer.addView(child, index)
  }
  override fun addView(child: View?, params: ViewGroup.LayoutParams?) {
    if (child === contentContainer) super.addView(child, toHostLayoutParams(params)) else contentContainer.addView(child, params)
  }
  override fun addView(child: View?, index: Int, params: ViewGroup.LayoutParams?) {
    if (child === contentContainer) super.addView(child, index, toHostLayoutParams(params)) else contentContainer.addView(child, index, params)
  }
  override fun addView(child: View?, width: Int, height: Int) {
    if (child === contentContainer) super.addView(child, width, height) else contentContainer.addView(child, width, height)
  }
  override fun updateViewLayout(view: View?, params: ViewGroup.LayoutParams?) {
    if (view === contentContainer) super.updateViewLayout(view, toHostLayoutParams(params)) else contentContainer.updateViewLayout(view, params)
  }
  override fun removeView(view: View?) {
    if (view === contentContainer) super.removeView(view) else contentContainer.removeView(view)
  }
  override fun removeViewAt(index: Int) = contentContainer.removeViewAt(index)
  override fun removeViews(start: Int, count: Int) = contentContainer.removeViews(start, count)
  override fun removeViewsInLayout(start: Int, count: Int) = contentContainer.removeViewsInLayout(start, count)
  override fun removeAllViews() = contentContainer.removeAllViews()
  override fun removeAllViewsInLayout() = contentContainer.removeAllViewsInLayout()
  override fun getChildCount(): Int = contentContainer.childCount
  override fun getChildAt(index: Int): View? = contentContainer.getChildAt(index)
  override fun indexOfChild(child: View?): Int = contentContainer.indexOfChild(child)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val measuredWidth = MeasureSpec.getSize(widthMeasureSpec)
    val measuredHeight = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(measuredWidth, measuredHeight)
    contentContainer.measure(
      MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    contentContainer.layout(0, 0, right - left, bottom - top)
  }

  private fun toHostLayoutParams(params: ViewGroup.LayoutParams?): LayoutParams = when (params) {
    null -> LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    is LayoutParams -> params
    else -> LayoutParams(params)
  }

  /** Fabric applies each child's Yoga bounds directly; do not replace them with FrameLayout's origin. */
  private class LayoutPassthroughFrameLayout(context: Context) : FrameLayout(context) {
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit
  }
}
