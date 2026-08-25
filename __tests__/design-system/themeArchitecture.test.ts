import fs from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '../..');
const SOURCE_ROOTS = ['app', 'src'].map((segment) => path.join(APP_ROOT, segment));

function collectSourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return collectSourceFiles(absolutePath);
    }

    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function relativePath(filePath: string) {
  return path.relative(APP_ROOT, filePath).replaceAll('\\', '/');
}

function findMatches(
  files: readonly string[],
  pattern: RegExp,
) {
  return files.flatMap((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return pattern.test(source) ? [relativePath(filePath)] : [];
  });
}

describe('theme and material architecture boundaries', () => {
  const sourceFiles = SOURCE_ROOTS.flatMap(collectSourceFiles);

  it('does not reintroduce the removed global appearance discriminator or glass helpers', () => {
    const forbidden = /\b(?:surfaceKind|ThemeAppearance|getThemeAppearance|getThemeActionContentClassName|GlassSpecular|TabBarGlassBackground|getGlassCornerRadiusStyle|getGlassSurfaceFrameStyle|forceNativeAndroidBlur)\b/;

    expect(findMatches(sourceFiles, forbidden)).toEqual([]);
  });

  it('keeps generic app UI free from theme-id branching', () => {
    const genericUiFiles = sourceFiles.filter((filePath) => (
      /[\\/](?:app|components|ui)[\\/]/.test(filePath)
    ));
    const themeIdBranch = /(?:themeId|resolvedTheme\.id)\s*(?:===|!==|==|!=)/;

    expect(findMatches(genericUiFiles, themeIdBranch)).toEqual([]);
  });

  it('keeps foreground paint behind semantic roles instead of palette-class parsing', () => {
    const rawForegroundClass = /(?:dark:)?text-(?:typography|primary|success|warning|error|info)-\d+/;
    expect(findMatches(sourceFiles, rawForegroundClass)).toEqual([]);

    const composedRoleWithoutColor = sourceFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const invalidTag = [...source.matchAll(/<Text\b[\s\S]*?>/g)].some(({ 0: tag }) => (
        tag.includes('composeTextRole') && !tag.includes('colorRole=')
      ));
      return invalidTag ? [relativePath(filePath)] : [];
    });

    expect(composedRoleWithoutColor).toEqual([]);
  });

  it('keeps raw live-effect imports inside the renderer and target-ownership boundary', () => {
    const effectFiles = sourceFiles.filter((filePath) => (
      /\b(?:BlurView|BlurTargetView|GlassView|expo-blur|expo-glass-effect)\b/.test(
        fs.readFileSync(filePath, 'utf8'),
      )
    ));

    expect(effectFiles.map(relativePath).sort()).toEqual([
      'src/components/ui/ScreenShell.tsx',
      'src/design-system/materials/EffectSurface.tsx',
      'src/design-system/materials/MaterialEnvironmentProvider.tsx',
    ]);
  });

  it('keeps representative content surfaces dense and free from live effects', () => {
    const denseContentFiles = [
      'src/components/ui/ChatMessageBubble.tsx',
      'src/components/ui/ProgressBar.tsx',
      'src/design-system/materials/Surface.tsx',
    ].map((filePath) => path.join(APP_ROOT, filePath));

    expect(findMatches(denseContentFiles, /\b(?:BlurView|BlurTargetView|GlassView)\b/)).toEqual([]);
  });
});
