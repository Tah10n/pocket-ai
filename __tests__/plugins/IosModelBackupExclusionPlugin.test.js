const withIosModelBackupExclusion = require('../../plugins/withIosModelBackupExclusion');

describe('iOS model backup exclusion config plugin', () => {
  it('injects Swift AppDelegate backup exclusion for downloaded models', () => {
    const appDelegate = {
      language: 'swift',
      contents: `import Expo

public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`,
    };

    const result = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);

    expect(result.contents).toContain('import Foundation');
    expect(result.contents).toContain('excludePocketAiModelDirectoryFromBackup()');
    expect(result.contents).toContain('URLResourceValues()');
    expect(result.contents).toContain('resourceValues.isExcludedFromBackup = true');
    expect(result.contents.indexOf('excludePocketAiModelDirectoryFromBackup()'))
      .toBeLessThan(result.contents.indexOf('return super.application'));
  });

  it('injects Objective-C AppDelegate backup exclusion for downloaded models', () => {
    const appDelegate = {
      language: 'objc',
      contents: `#import "AppDelegate.h"

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

@end
`,
    };

    const result = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);

    expect(result.contents).toContain('[self excludePocketAiModelDirectoryFromBackup];');
    expect(result.contents).toContain('NSURLIsExcludedFromBackupKey');
    expect(result.contents.indexOf('[self excludePocketAiModelDirectoryFromBackup];'))
      .toBeLessThan(result.contents.indexOf('return [super application'));
  });

  it('is idempotent', () => {
    const appDelegate = {
      language: 'swift',
      contents: `import Expo

public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`,
    };

    const once = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);
    const twice = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(once);

    expect(twice.contents.match(/^import Foundation$/gm)).toHaveLength(1);
    expect(twice.contents).toBe(once.contents);
  });
});
