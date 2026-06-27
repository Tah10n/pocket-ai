const withIosModelBackupExclusion = require('../../plugins/withIosModelBackupExclusion');

function countOccurrences(contents, needle) {
  return contents.split(needle).length - 1;
}

describe('iOS model backup exclusion config plugin', () => {
  it('injects Swift AppDelegate backup exclusion for downloaded models and chat attachments', () => {
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
    expect(result.contents).toContain('["models", "chat-attachments"]');
    expect(result.contents).toContain('appendingPathComponent(directoryName, isDirectory: true)');
    expect(result.contents).toContain('URLResourceValues()');
    expect(result.contents).toContain('resourceValues.isExcludedFromBackup = true');
    expect(result.contents.indexOf('excludePocketAiModelDirectoryFromBackup()'))
      .toBeLessThan(result.contents.indexOf('return super.application'));
  });

  it('injects Objective-C AppDelegate backup exclusion for downloaded models and chat attachments', () => {
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
    expect(result.contents).toContain('@[@"models", @"chat-attachments"]');
    expect(result.contents).toContain('URLByAppendingPathComponent:directoryName isDirectory:YES');
    expect(result.contents).toContain('NSURLIsExcludedFromBackupKey');
    expect(result.contents.indexOf('[self excludePocketAiModelDirectoryFromBackup];'))
      .toBeLessThan(result.contents.indexOf('return [super application'));
  });

  it.each([
    [
      'swift',
      `import Expo

public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`,
      '    excludePocketAiModelDirectoryFromBackup()\n',
      'private func excludePocketAiModelDirectoryFromBackup()',
    ],
    [
      'objc',
      `#import "AppDelegate.h"

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

@end
`,
      '[self excludePocketAiModelDirectoryFromBackup];',
      '- (void)excludePocketAiModelDirectoryFromBackup',
    ],
  ])('is idempotent for %s AppDelegate injection', (language, contents, callNeedle, methodNeedle) => {
    const appDelegate = { language, contents };

    const once = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);
    const twice = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(once);

    if (language === 'swift') {
      expect(twice.contents.match(/^import Foundation$/gm)).toHaveLength(1);
    }

    expect(countOccurrences(twice.contents, callNeedle)).toBe(1);
    expect(countOccurrences(twice.contents, methodNeedle)).toBe(1);
    expect(countOccurrences(twice.contents, 'models')).toBe(1);
    expect(countOccurrences(twice.contents, 'chat-attachments')).toBe(1);
    expect(twice.contents).toBe(once.contents);
  });

  it('migrates previously injected Swift model-only exclusion methods', () => {
    const appDelegate = {
      language: 'swift',
      contents: `import Expo
import Foundation

public class AppDelegate: ExpoAppDelegate {
  private let unrelatedAttachmentDirectoryName = "chat-attachments"

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Pocket AI: exclude downloaded GGUF files from backups.
    excludePocketAiModelDirectoryFromBackup()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  private func excludePocketAiModelDirectoryFromBackup() {
    let fileManager = FileManager.default
    guard let documentsDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return
    }

    let modelsDirectory = documentsDirectory.appendingPathComponent("models", isDirectory: true)
    let legacyMigrationNote = "chat-attachments should be handled by a future migration"
    try? fileManager.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)

    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableModelsDirectory = modelsDirectory
    try? mutableModelsDirectory.setResourceValues(resourceValues)
  }
}
`,
    };

    const result = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);

    expect(result.contents).toContain('["models", "chat-attachments"]');
    expect(result.contents).toContain('private let unrelatedAttachmentDirectoryName = "chat-attachments"');
    expect(result.contents).not.toContain('legacyMigrationNote');
    expect(result.contents).not.toContain('let modelsDirectory =');
    expect(countOccurrences(result.contents, 'private func excludePocketAiModelDirectoryFromBackup()')).toBe(1);
    expect(countOccurrences(result.contents, '"chat-attachments"')).toBe(2);
  });

  it('migrates Swift model-only methods with 4-space indentation and multi-line bodies', () => {
    const appDelegate = {
      language: 'swift',
      contents: `import Expo
import Foundation

public class AppDelegate: ExpoAppDelegate {
    public override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Pocket AI: exclude downloaded GGUF files from backups.
        excludePocketAiModelDirectoryFromBackup()
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    private func excludePocketAiModelDirectoryFromBackup()
    {
        let fileManager = FileManager.default
        guard let documentsDirectory = fileManager.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else {
            return
        }

        let modelsDirectory = documentsDirectory.appendingPathComponent(
            "models",
            isDirectory: true
        )
        try? fileManager.createDirectory(
            at: modelsDirectory,
            withIntermediateDirectories: true
        )
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutableModelsDirectory = modelsDirectory
        try? mutableModelsDirectory.setResourceValues(resourceValues)
    }
}
`,
    };

    const result = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);

    expect(result.contents).toContain('["models", "chat-attachments"]');
    expect(result.contents).not.toContain('let modelsDirectory =');
    expect(countOccurrences(result.contents, 'private func excludePocketAiModelDirectoryFromBackup()')).toBe(1);
    expect(countOccurrences(result.contents, 'chat-attachments')).toBe(1);
  });

  it('migrates previously injected Objective-C model-only exclusion methods', () => {
    const appDelegate = {
      language: 'objc',
      contents: `#import "AppDelegate.h"

@implementation AppDelegate

static NSString *const UnrelatedAttachmentDirectoryName = @"chat-attachments";

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  // Pocket AI: exclude downloaded GGUF files from backups.
  [self excludePocketAiModelDirectoryFromBackup];
  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (void)excludePocketAiModelDirectoryFromBackup
{
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSURL *documentsDirectory = [[fileManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] firstObject];
  if (!documentsDirectory) {
    return;
  }

  NSURL *modelsDirectory = [documentsDirectory URLByAppendingPathComponent:@"models" isDirectory:YES];
  NSString *legacyMigrationNote = @"chat-attachments should be handled by a future migration";
  [fileManager createDirectoryAtURL:modelsDirectory withIntermediateDirectories:YES attributes:nil error:nil];
  [modelsDirectory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}

@end
`,
    };

    const result = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);

    expect(result.contents).toContain('@[@"models", @"chat-attachments"]');
    expect(result.contents).not.toContain('legacyMigrationNote');
    expect(result.contents).not.toContain('NSURL *modelsDirectory');
    expect(countOccurrences(result.contents, '- (void)excludePocketAiModelDirectoryFromBackup')).toBe(1);
  });

  it('migrates Objective-C model-only methods with same-line braces and preserves unrelated attachment strings', () => {
    const appDelegate = {
      language: 'objc',
      contents: `#import "AppDelegate.h"

@implementation AppDelegate

static NSString *const UnrelatedAttachmentDirectoryName = @"chat-attachments";

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    // Pocket AI: exclude downloaded GGUF files from backups.
    [self excludePocketAiModelDirectoryFromBackup];
    return YES;
}

- (void)excludePocketAiModelDirectoryFromBackup {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *documentsDirectory = [[fileManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] firstObject];
    if (!documentsDirectory) {
        return;
    }

    NSURL *modelsDirectory = [documentsDirectory URLByAppendingPathComponent:@"models" isDirectory:YES];
    [fileManager createDirectoryAtURL:modelsDirectory withIntermediateDirectories:YES attributes:nil error:nil];
    [modelsDirectory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}

@end
`,
    };

    const result = withIosModelBackupExclusion._internal.applyIosModelBackupExclusionToAppDelegate(appDelegate);

    expect(result.contents).toContain('@[@"models", @"chat-attachments"]');
    expect(result.contents).toContain('static NSString *const UnrelatedAttachmentDirectoryName = @"chat-attachments";');
    expect(result.contents).not.toContain('NSURL *modelsDirectory');
    expect(countOccurrences(result.contents, '- (void)excludePocketAiModelDirectoryFromBackup')).toBe(1);
    expect(countOccurrences(result.contents, '@"chat-attachments"')).toBe(2);
  });
});
