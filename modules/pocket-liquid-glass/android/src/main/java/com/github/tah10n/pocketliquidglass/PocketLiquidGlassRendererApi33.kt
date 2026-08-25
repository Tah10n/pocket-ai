package com.github.tah10n.pocketliquidglass

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Path
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import androidx.annotation.RequiresApi
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
internal class PocketLiquidGlassRendererApi33 : PocketLiquidGlassRenderer {
  private val surfaceNode = RenderNode("PocketLiquidGlassSurfaceCrop")
  private val providerLocation = IntArray(2)
  private val surfaceLocation = IntArray(2)
  private var shader: RuntimeShader? = null
  private var renderEffect: RenderEffect? = null
  private var recordedProvider: PocketLiquidGlassBackdropProvider? = null
  private var recordedSceneGeneration = -1L
  private var recordedCrop = CropBounds.EMPTY
  private var recordedSurfaceWidth = -1
  private var recordedSurfaceHeight = -1

  override fun draw(
    canvas: Canvas,
    provider: PocketLiquidGlassBackdropProvider,
    surface: PocketLiquidGlassSurface,
    shapePath: Path,
    pressedAmount: Float,
  ): Boolean {
    return try {
      val crop = resolveCrop(provider, surface) ?: return false
      val runtimeShader = shader ?: RuntimeShader(AGSL).also { shader = it }
      if (
        recordedProvider !== provider || recordedSceneGeneration != provider.recordedSceneGeneration
        || recordedCrop != crop
        || recordedSurfaceWidth != surface.width || recordedSurfaceHeight != surface.height
        || !surfaceNode.hasDisplayList()
      ) recordExpandedCrop(provider, crop, surface)
      updateUniforms(runtimeShader, crop, surface, pressedAmount)
      if (renderEffect == null) {
        val blurRadius = BLUR_RADIUS_DP * surface.resources.displayMetrics.density
        val blur = RenderEffect.createBlurEffect(blurRadius, blurRadius, Shader.TileMode.CLAMP)
        val optics = RenderEffect.createRuntimeShaderEffect(runtimeShader, "content")
        renderEffect = RenderEffect.createChainEffect(optics, blur)
        surfaceNode.setRenderEffect(renderEffect)
      }
      val save = canvas.save()
      try {
        canvas.clipPath(shapePath)
        canvas.drawRenderNode(surfaceNode)
      } finally {
        canvas.restoreToCount(save)
      }
      true
    } catch (_: Throwable) {
      renderEffect = null
      surfaceNode.setRenderEffect(null)
      false
    }
  }

  override fun invalidateMaterial() {
    renderEffect = null
    surfaceNode.setRenderEffect(null)
  }

  override fun dispose() {
    surfaceNode.setRenderEffect(null)
    surfaceNode.discardDisplayList()
    shader = null
    renderEffect = null
    recordedProvider = null
    recordedSceneGeneration = -1L
    recordedCrop = CropBounds.EMPTY
  }

  private fun resolveCrop(provider: PocketLiquidGlassBackdropProvider, surface: PocketLiquidGlassSurface): CropBounds? {
    if (provider.windowToken === surface.windowToken) {
      provider.getLocationInWindow(providerLocation)
      surface.getLocationInWindow(surfaceLocation)
    } else {
      provider.getLocationOnScreen(providerLocation)
      surface.getLocationOnScreen(surfaceLocation)
    }
    val surfaceX = surfaceLocation[0] - providerLocation[0]
    val surfaceY = surfaceLocation[1] - providerLocation[1]
    val margin = ceil(CROP_MARGIN_DP * surface.resources.displayMetrics.density).toInt()
    val left = max(0, surfaceX - margin)
    val top = max(0, surfaceY - margin)
    val right = min(provider.width, surfaceX + surface.width + margin)
    val bottom = min(provider.height, surfaceY + surface.height + margin)
    if (right <= left || bottom <= top) return null
    return CropBounds(left, top, right, bottom, surfaceX - left, surfaceY - top)
  }

  private fun recordExpandedCrop(provider: PocketLiquidGlassBackdropProvider, crop: CropBounds, surface: PocketLiquidGlassSurface) {
    surfaceNode.setPosition(0, 0, crop.width, crop.height)
    val recordingCanvas = surfaceNode.beginRecording(crop.width, crop.height)
    try {
      recordingCanvas.translate(-crop.left.toFloat(), -crop.top.toFloat())
      provider.drawRecordedScene(recordingCanvas)
    } finally {
      surfaceNode.endRecording()
    }
    surfaceNode.translationX = -crop.surfaceOriginX.toFloat()
    surfaceNode.translationY = -crop.surfaceOriginY.toFloat()
    recordedProvider = provider
    recordedSceneGeneration = provider.recordedSceneGeneration
    recordedCrop = crop
    recordedSurfaceWidth = surface.width
    recordedSurfaceHeight = surface.height
    renderEffect = null
    surfaceNode.setRenderEffect(null)
  }

  private fun updateUniforms(shader: RuntimeShader, crop: CropBounds, surface: PocketLiquidGlassSurface, pressedAmount: Float) {
    val density = surface.resources.displayMetrics.density
    shader.setFloatUniform("size", surface.width.toFloat(), surface.height.toFloat())
    shader.setFloatUniform("origin", crop.surfaceOriginX.toFloat(), crop.surfaceOriginY.toFloat())
    shader.setFloatUniform("backdropSize", crop.width.toFloat(), crop.height.toFloat())
    shader.setFloatUniform(
      "radii",
      surface.cornerRadiusTopLeftDp * density,
      surface.cornerRadiusTopRightDp * density,
      surface.cornerRadiusBottomRightDp * density,
      surface.cornerRadiusBottomLeftDp * density,
    )
    shader.setFloatUniform("dark", if (surface.isDarkMaterial) 1f else 0f)
    shader.setFloatUniform("pressed", pressedAmount)
    shader.setFloatUniform("density", density)
    shader.setFloatUniform("materialTintOpacity", surface.materialTintOpacity)
    shader.setFloatUniform(
      "materialTint",
      Color.red(surface.materialTintColor) / 255f,
      Color.green(surface.materialTintColor) / 255f,
      Color.blue(surface.materialTintColor) / 255f,
    )
  }

  internal data class CropBounds(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
    val surfaceOriginX: Int,
    val surfaceOriginY: Int,
  ) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    companion object { val EMPTY = CropBounds(0, 0, 0, 0, 0, 0) }
  }

  internal companion object {
    internal const val BLUR_RADIUS_DP = 10f
    internal const val CROP_MARGIN_DP = 16f
    internal val AGSL = """
      uniform shader content;
      uniform float2 size;
      uniform float2 origin;
      uniform float2 backdropSize;
      uniform float4 radii;
      uniform float dark;
      uniform float pressed;
      uniform float density;
      uniform float3 materialTint;
      uniform float materialTintOpacity;

      float hash(float2 p) {
        return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453);
      }

      float2 roundedRectNormal(float2 centered, float2 q) {
        float2 outside = max(q, float2(0.0));
        if (dot(outside, outside) > 0.0001) return normalize(outside) * sign(centered);
        return q.x > q.y ? float2(sign(centered.x), 0.0) : float2(0.0, sign(centered.y));
      }

      float bevelProfile(float sdf, float pixelDensity) {
        return 1.0 - smoothstep(0.0, max(11.0 * pixelDensity, 1.0), max(-sdf, 0.0));
      }

      half4 main(float2 cropPosition) {
        float2 p = cropPosition - origin;
        float2 halfSize = max(size * 0.5, float2(1.0));
        float2 centered = p - halfSize;
        float selectedRadius = centered.x < 0.0
          ? (centered.y < 0.0 ? radii.x : radii.w)
          : (centered.y < 0.0 ? radii.y : radii.z);
        float safeRadius = min(max(selectedRadius, 0.5), min(halfSize.x, halfSize.y));
        float2 q = abs(centered) - (halfSize - safeRadius);
        float sdf = length(max(q, float2(0.0))) + min(max(q.x, q.y), 0.0) - safeRadius;
        float mask = 1.0 - smoothstep(-1.0, 1.0, sdf);
        float bevel = bevelProfile(sdf, density);
        float2 normal = roundedRectNormal(centered, q);
        float2 normalizedPosition = centered / halfSize;
        float bodyProfile = max(abs(normalizedPosition.x), abs(normalizedPosition.y));
        float2 bodyLens = normalizedPosition * density * (0.22 + bodyProfile * 0.18 + pressed * 0.12);
        float edgeLens = bevel * density * (0.72 + pressed * 0.38);
        float2 refracted = clamp(p - bodyLens - normal * edgeLens, float2(0.0), size - float2(1.0));
        float dispersion = bevel * density * 0.16;
        float2 samplePosition = clamp(refracted + origin, float2(0.0), backdropSize - float2(1.0));
        half4 base = content.eval(samplePosition);
        half3 rgb = base.rgb;
        if (bevel > 0.01) {
          rgb.r = content.eval(clamp(samplePosition + normal * dispersion, float2(0.0), backdropSize - float2(1.0))).r;
          rgb.b = content.eval(clamp(samplePosition - normal * dispersion, float2(0.0), backdropSize - float2(1.0))).b;
        }
        half luminance = dot(rgb, half3(0.2126, 0.7152, 0.0722));
        rgb = mix(half3(luminance), rgb, half(1.08));
        rgb = (rgb - half3(0.5)) * half3(1.035) + half3(0.5);
        half3 neutralTint = mix(half3(0.94, 0.97, 1.0), half3(0.035, 0.06, 0.11), half(dark));
        rgb = mix(neutralTint, rgb, base.a);
        rgb = mix(rgb, neutralTint, half(dark > 0.5 ? 0.11 : 0.055));
        rgb = mix(rgb, half3(materialTint), half(materialTintOpacity));
        float fresnel = bevel * pow(max(dot(normal, normalize(float2(-0.65, -0.76))), 0.0), 2.0);
        rgb += half3(fresnel * (0.065 + pressed * 0.035));
        rgb += half3((hash(floor(p)) - 0.5) / 255.0);
        return half4(clamp(rgb, half3(0.0), half3(1.0)), half(mask));
      }
    """.trimIndent()
  }
}
