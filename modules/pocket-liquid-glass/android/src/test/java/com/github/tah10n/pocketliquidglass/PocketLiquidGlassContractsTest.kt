package com.github.tah10n.pocketliquidglass

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PocketLiquidGlassContractsTest {
  @Test
  fun resolvesApiAndFailureTiers() {
    assertEquals(NativeGlassRenderer.LIQUID_GLASS, resolveNativeGlassRenderer(33, true, true, false))
    assertEquals(NativeGlassRenderer.DENSE, resolveNativeGlassRenderer(31, true, true, false))
    assertEquals(NativeGlassRenderer.DENSE, resolveNativeGlassRenderer(30, true, true, false))
    assertEquals(NativeGlassRenderer.DENSE, resolveNativeGlassRenderer(33, false, true, false))
    assertEquals(NativeGlassRenderer.DENSE, resolveNativeGlassRenderer(33, true, false, false))
    assertEquals(NativeGlassRenderer.DENSE, resolveNativeGlassRenderer(33, true, true, true))
  }

  @Test
  fun allowsTheSharedProviderAcrossActivityAndModalWindows() {
    assertTrue(isBackdropSourceAllowed(BackdropSourceRelation.SHARED_PROVIDER))
    assertTrue(isBackdropSourceAllowed(BackdropSourceRelation.DIFFERENT_WINDOW))
    assertFalse(isBackdropSourceAllowed(BackdropSourceRelation.SELF))
    assertFalse(isBackdropSourceAllowed(BackdropSourceRelation.ANCESTOR))
    assertFalse(isBackdropSourceAllowed(BackdropSourceRelation.DETACHED))
  }

  @Test
  fun confinesRefractionToTheRoundedRectangleBevel() {
    val shader = PocketLiquidGlassRendererApi33.AGSL

    assertTrue(shader.contains("float bevel = bevelProfile(sdf, density);"))
    assertTrue(shader.contains("float2 normal = roundedRectNormal(centered, q);"))
    assertTrue(shader.contains("float2 bodyLens = normalizedPosition * density"))
    assertTrue(shader.contains("float2 p = cropPosition - origin;"))
    assertTrue(shader.contains("refracted + origin"))
    assertTrue(shader.contains("rgb = mix(rgb, half3(materialTint)"))
    assertTrue(shader.contains("return 1.0 - smoothstep"))
    assertFalse(shader.contains("float entry ="))
    assertFalse(shader.contains("float exit ="))
    assertFalse(shader.contains("float2 direction = normalize(centered"))
    assertFalse(shader.contains("float rim = 1.0 - smoothstep"))
  }

  @Test
  fun boundsEachEffectToAnExpandedSurfaceCrop() {
    assertEquals(10f, PocketLiquidGlassRendererApi33.BLUR_RADIUS_DP)
    assertTrue(PocketLiquidGlassRendererApi33.CROP_MARGIN_DP > PocketLiquidGlassRendererApi33.BLUR_RADIUS_DP)
    assertEquals(3, PocketLiquidGlassSurface.MAX_RENDER_ATTEMPTS)
  }

  @Test
  fun mapsTheProviderOriginIntoSurfaceLocalCoordinates() {
    assertEquals(
      BackdropTranslation(-42, -1452),
      resolveBackdropTranslation(providerX = 0, providerY = 0, surfaceX = 42, surfaceY = 1452),
    )
    assertEquals(
      BackdropTranslation(-42, -1959),
      resolveBackdropTranslation(providerX = 0, providerY = 0, surfaceX = 42, surfaceY = 1959),
    )
  }
}
