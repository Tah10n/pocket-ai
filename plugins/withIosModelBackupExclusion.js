const { withAppDelegate } = require('expo/config-plugins');

const SWIFT_CALL_MARKER = 'Pocket AI: exclude downloaded GGUF files from backups.';
const SWIFT_METHOD_MARKER = 'private func excludePocketAiModelDirectoryFromBackup()';
const OBJC_CALL_MARKER = 'Pocket AI: exclude downloaded GGUF files from backups.';
const OBJC_METHOD_MARKER = '- (void)excludePocketAiModelDirectoryFromBackup';

const SWIFT_CALL_BLOCK = `    // ${SWIFT_CALL_MARKER}
    excludePocketAiModelDirectoryFromBackup()
`;

const SWIFT_METHOD_BLOCK = `
  private func excludePocketAiModelDirectoryFromBackup() {
    let fileManager = FileManager.default
    guard let documentsDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return
    }

    let modelsDirectory = documentsDirectory.appendingPathComponent("models", isDirectory: true)
    try? fileManager.createDirectory(at: modelsDirectory, withIntermediateDirectories: true)

    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableModelsDirectory = modelsDirectory
    try? mutableModelsDirectory.setResourceValues(resourceValues)
  }
`;

const OBJC_CALL_BLOCK = `  // ${OBJC_CALL_MARKER}
  [self excludePocketAiModelDirectoryFromBackup];
`;

const OBJC_METHOD_BLOCK = `
- (void)excludePocketAiModelDirectoryFromBackup
{
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSURL *documentsDirectory = [[fileManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] firstObject];
  if (!documentsDirectory) {
    return;
  }

  NSURL *modelsDirectory = [documentsDirectory URLByAppendingPathComponent:@"models" isDirectory:YES];
  [fileManager createDirectoryAtURL:modelsDirectory withIntermediateDirectories:YES attributes:nil error:nil];
  [modelsDirectory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
}
`;

function insertBeforeLastOccurrence(contents, needle, insertion) {
  const index = contents.lastIndexOf(needle);
  if (index < 0) {
    return contents;
  }

  return `${contents.slice(0, index)}${insertion}${contents.slice(index)}`;
}

function addSwiftBackupExclusion(contents) {
  let nextContents = contents;

  if (!nextContents.includes(SWIFT_CALL_MARKER)) {
    nextContents = nextContents.replace(
      /(\n\s*return\s+super\.application\(application,\s*didFinishLaunchingWithOptions:\s*launchOptions\))/,
      `\n${SWIFT_CALL_BLOCK}$1`,
    );
  }

  if (!nextContents.includes(SWIFT_METHOD_MARKER)) {
    nextContents = insertBeforeLastOccurrence(nextContents, '\n}', SWIFT_METHOD_BLOCK);
  }

  return nextContents;
}

function addObjcBackupExclusion(contents) {
  let nextContents = contents;

  if (!nextContents.includes(OBJC_CALL_MARKER)) {
    nextContents = nextContents.replace(
      /(\n\s*return\s+(?:\[super application:application didFinishLaunchingWithOptions:launchOptions\]|YES);)/,
      `\n${OBJC_CALL_BLOCK}$1`,
    );
  }

  if (!nextContents.includes(OBJC_METHOD_MARKER)) {
    nextContents = insertBeforeLastOccurrence(nextContents, '\n@end', OBJC_METHOD_BLOCK);
  }

  return nextContents;
}

function applyIosModelBackupExclusionToAppDelegate(appDelegate) {
  if (!appDelegate || typeof appDelegate.contents !== 'string') {
    return appDelegate;
  }

  if (appDelegate.language === 'swift') {
    return {
      ...appDelegate,
      contents: addSwiftBackupExclusion(appDelegate.contents),
    };
  }

  if (appDelegate.language === 'objc' || appDelegate.language === 'objcpp') {
    return {
      ...appDelegate,
      contents: addObjcBackupExclusion(appDelegate.contents),
    };
  }

  return appDelegate;
}

function withIosModelBackupExclusion(config) {
  return withAppDelegate(config, (nextConfig) => {
    nextConfig.modResults = applyIosModelBackupExclusionToAppDelegate(nextConfig.modResults);
    return nextConfig;
  });
}

withIosModelBackupExclusion._internal = {
  applyIosModelBackupExclusionToAppDelegate,
};

module.exports = withIosModelBackupExclusion;
