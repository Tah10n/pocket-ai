package com.github.tah10n.pocketliquidglass

import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap

internal object PocketLiquidGlassBackdropRegistry {
  private var activeProvider = WeakReference<PocketLiquidGlassBackdropProvider>(null)
  private val consumers = Collections.newSetFromMap(
    WeakHashMap<PocketLiquidGlassSurface, Boolean>(),
  )

  fun activate(provider: PocketLiquidGlassBackdropProvider) {
    activeProvider = WeakReference(provider)
    notifyConsumers(providerChanged = true)
  }

  fun deactivate(provider: PocketLiquidGlassBackdropProvider) {
    if (activeProvider.get() === provider) {
      activeProvider.clear()
      notifyConsumers(providerChanged = true)
    }
  }

  fun current(): PocketLiquidGlassBackdropProvider? = activeProvider.get()?.takeIf {
    it.isAttachedToWindow && it.isProviderActive && it.hasRecordedScene
  }

  fun register(consumer: PocketLiquidGlassSurface) {
    consumers.add(consumer)
  }

  fun unregister(consumer: PocketLiquidGlassSurface) {
    consumers.remove(consumer)
  }

  fun notifySceneUpdated() {
    notifyConsumers(providerChanged = false)
  }

  private fun notifyConsumers(providerChanged: Boolean) {
    consumers.toList().forEach {
      if (providerChanged) it.onBackdropProviderChanged() else it.postInvalidateOnAnimation()
    }
  }
}

internal object PocketLiquidGlassCapturePass {
  // The factory-style ThreadLocal initializer is API 26 on Android. Keep this guard safe
  // for the app's API 24 minSdk without relying on core-library desugaring.
  private val depth = object : ThreadLocal<Int>() {
    override fun initialValue(): Int = 0
  }

  val active: Boolean
    get() = (depth.get() ?: 0) > 0

  inline fun <T> run(block: () -> T): T {
    depth.set((depth.get() ?: 0) + 1)
    return try {
      block()
    } finally {
      depth.set(((depth.get() ?: 1) - 1).coerceAtLeast(0))
    }
  }
}
