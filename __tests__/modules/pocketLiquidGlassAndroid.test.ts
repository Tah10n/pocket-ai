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
    expect(provider).toContain('recorderGeneration += 1');
    expect(renderer).toContain('recordedSceneGeneration != provider.recordedSceneGeneration');
  });

  it('passes recipe tint opacity into the runtime shader', () => {
    expect(read('PocketLiquidGlassSurface.kt')).toContain('materialTintOpacity');
    const renderer = read('PocketLiquidGlassRendererApi33.kt');
    expect(renderer).toContain('materialTintOpacity');
    expect(renderer).not.toContain('dark > 0.5 ? 0.11 : 0.095');
  });
});
