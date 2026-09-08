import fs from 'node:fs';
import path from 'node:path';

const nativeRoot = path.join(
  process.cwd(),
  'modules',
  'pocket-liquid-glass',
  'android',
  'src',
  'main',
  'java',
  'com',
  'github',
  'tah10n',
  'pocketliquidglass',
);

function read(name: string) {
  return fs.readFileSync(path.join(nativeRoot, name), 'utf8');
}

describe('Pocket Liquid Glass Android source boundaries', () => {
  it.each([
    'PocketLiquidGlassModule.kt',
    'PocketLiquidGlassBackdropProvider.kt',
    'PocketLiquidGlassSurface.kt',
  ])('keeps API 33 graphics types out of the minSdk host %s', (name) => {
    expect(read(name)).not.toMatch(/\b(RenderNode|RenderEffect|RuntimeShader)\b/);
  });

  it('isolates API 33 scene recording and rendering', () => {
    expect(read('PocketLiquidGlassSceneRecorderApi33.kt')).toContain('@RequiresApi(Build.VERSION_CODES.TIRAMISU)');
    expect(read('PocketLiquidGlassRendererApi33.kt')).toContain('@RequiresApi(Build.VERSION_CODES.TIRAMISU)');
    expect(read('PocketLiquidGlassBackdropProvider.kt')).toContain('Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU');
  });

  it('uses expanded effected crops without bitmap readback or a provider-sized effect node', () => {
    const renderer = read('PocketLiquidGlassRendererApi33.kt');
    expect(renderer).toContain('CROP_MARGIN_DP = 16f');
    expect(renderer).toContain('surfaceNode.setPosition(0, 0, crop.width, crop.height)');
    expect(renderer).not.toContain('surfaceNode.setPosition(0, 0, provider.width, provider.height)');
    expect(renderer).not.toMatch(/\bBitmap\b/);
  });

  it('keeps failure retries bounded and semantic fallback paint typed', () => {
    const surface = read('PocketLiquidGlassSurface.kt');
    expect(surface).toContain('MAX_RENDER_ATTEMPTS = 3');
    expect(surface).toContain('fallbackColor');
    expect(surface).toContain('fallbackBorderColor');
    expect(surface).toContain('onBackdropProviderChanged');
    expect(surface).toContain('onWindowFocusChanged');
  });

  it('invalidates external surfaces immediately when the active provider changes', () => {
    const surface = read('PocketLiquidGlassSurface.kt');
    const handler = surface.slice(
      surface.indexOf('internal fun onBackdropProviderChanged()'),
      surface.indexOf('private fun findProvider()'),
    );
    expect(handler).toContain('recordedProvider = null');
    expect(handler).toContain('resetRendererFailure()');
    expect(handler).toContain('renderer?.invalidateMaterial()');
    expect(handler).toContain('postInvalidateOnAnimation()');
  });

  it('refreshes the shared scene and surfaces on the next frame when appearance changes', () => {
    const module = read('PocketLiquidGlassModule.kt');
    const provider = read('PocketLiquidGlassBackdropProvider.kt');
    const surface = read('PocketLiquidGlassSurface.kt');
    const revisionSetter = provider.slice(
      provider.indexOf('var sceneRevision'),
      provider.indexOf('init {'),
    );
    const visualRefresh = surface.slice(
      surface.indexOf('private fun requestVisualRefresh()'),
      surface.indexOf('private fun resetRendererFailure()'),
    );

    expect(module).toContain('Prop("sceneRevision")');
    expect(revisionSetter).toContain('resetCaptureFailure()');
    expect(revisionSetter).toContain('postInvalidateOnAnimation()');
    expect(surface).toContain('requestVisualRefresh()');
    expect(visualRefresh).toContain('postInvalidateOnAnimation()');
  });

  it('keeps the capture guard API 24-safe and excludes the complete effect subtree', () => {
    const registry = read('PocketLiquidGlassBackdropRegistry.kt');
    const exclusion = read('PocketLiquidGlassCaptureExclusion.kt');
    const recorder = read('PocketLiquidGlassSceneRecorderApi33.kt');
    expect(registry).not.toContain('ThreadLocal.withInitial');
    expect(registry).toContain('object : ThreadLocal<Int>()');
    expect(exclusion).toContain('override fun draw(canvas: Canvas)');
    expect(exclusion).toContain('PocketLiquidGlassCapturePass.active');
    expect(exclusion).toContain('if (PocketLiquidGlassCapturePass.active) return');
    expect(exclusion).toContain('private val contentContainer = LayoutPassthroughFrameLayout(context)');
    expect(exclusion).toContain('contentContainer.layout(0, 0, right - left, bottom - top)');
    expect(exclusion).toContain('override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit');
    expect(recorder).toContain('private val scenePicture = Picture()');
    expect(recorder).toContain('scenePicture.draw(nodeCanvas)');
    expect(recorder).not.toContain('.alpha =');
    expect(recorder).not.toContain('.visibility =');
    expect(recorder).not.toContain('Bitmap');
  });

  it('completes the visible pass before recording the next shared scene', () => {
    const provider = read('PocketLiquidGlassBackdropProvider.kt');
    expect(provider.indexOf('super.dispatchDraw(canvas)')).toBeLessThan(
      provider.indexOf('activeRecorder.capture(sceneContainer)'),
    );
  });

  it('guards provider capture failures with bounded recovery', () => {
    const provider = read('PocketLiquidGlassBackdropProvider.kt');
    const renderer = read('PocketLiquidGlassRendererApi33.kt');
    expect(provider).toContain('MAX_CAPTURE_ATTEMPTS = 3');
    expect(provider).toContain('activeRecorder.capture(sceneContainer)');
    expect(provider).toContain('catch (_: Throwable)');
    expect(provider).toContain('scheduleCaptureRetry()');
    expect(renderer).toContain('recordedSceneGeneration != provider.recordedSceneGeneration');
  });

  it('refreshes changed backdrop scenes without a consumer invalidation loop', () => {
    const provider = read('PocketLiquidGlassBackdropProvider.kt');
    expect(provider).toContain('override fun onDescendantInvalidated(child: View, target: View)');
    expect(provider).toContain('if (isBackdropContentTarget(target)) sceneDirty = true');
    expect(provider).toContain('&& sceneDirty');
    expect(provider.indexOf('activeRecorder.capture(sceneContainer)')).toBeLessThan(
      provider.indexOf('recorderGeneration += 1'),
    );
    expect(provider.indexOf('recorderGeneration += 1')).toBeLessThan(
      provider.indexOf('PocketLiquidGlassBackdropRegistry.notifySceneUpdated()'),
    );
    expect(provider).toContain('candidate is PocketLiquidGlassCaptureExclusion || candidate is PocketLiquidGlassSurface');
    expect(provider).toContain('ViewTreeObserver.OnScrollChangedListener');
    expect(provider).toContain('postInvalidateOnAnimation()');
    expect(provider).toContain('observer.addOnScrollChangedListener(sceneScrollChangedListener)');
    expect(provider).toContain('removeOnScrollChangedListener(sceneScrollChangedListener)');
  });

  it('passes recipe tint opacity into the runtime shader', () => {
    expect(read('PocketLiquidGlassSurface.kt')).toContain('materialTintOpacity');
    const renderer = read('PocketLiquidGlassRendererApi33.kt');
    expect(renderer).toContain('materialTintOpacity');
    expect(renderer).not.toContain('dark > 0.5 ? 0.11 : 0.095');
  });
});
