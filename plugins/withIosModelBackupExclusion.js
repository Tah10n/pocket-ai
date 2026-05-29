const { withAppDelegate } = require('expo/config-plugins');

const SWIFT_CALL_MARKER = 'Pocket AI: exclude downloaded GGUF files from backups.';
const OBJC_CALL_MARKER = 'Pocket AI: exclude downloaded GGUF files from backups.';
const MODEL_DIRECTORY_NAME = 'models';
const CHAT_ATTACHMENTS_DIRECTORY_NAME = 'chat-attachments';

const SWIFT_CALL_BLOCK = `    // ${SWIFT_CALL_MARKER}
    excludePocketAiModelDirectoryFromBackup()
`;

const SWIFT_METHOD_BLOCK = `
  private func excludePocketAiModelDirectoryFromBackup() {
    let fileManager = FileManager.default
    guard let documentsDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return
    }

    let backupExcludedDirectoryNames = ["${MODEL_DIRECTORY_NAME}", "${CHAT_ATTACHMENTS_DIRECTORY_NAME}"]

    for directoryName in backupExcludedDirectoryNames {
      let directory = documentsDirectory.appendingPathComponent(directoryName, isDirectory: true)
      try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      var mutableDirectory = directory
      try? mutableDirectory.setResourceValues(resourceValues)
    }
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

  NSArray<NSString *> *backupExcludedDirectoryNames = @[@"${MODEL_DIRECTORY_NAME}", @"${CHAT_ATTACHMENTS_DIRECTORY_NAME}"];

  for (NSString *directoryName in backupExcludedDirectoryNames) {
    NSURL *directory = [documentsDirectory URLByAppendingPathComponent:directoryName isDirectory:YES];
    [fileManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
    [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  }
}
`;

const SWIFT_METHOD_SIGNATURE_REGEX = /\bprivate\s+func\s+excludePocketAiModelDirectoryFromBackup\s*\(\s*\)\s*/;
const OBJC_METHOD_SIGNATURE_REGEX = /-\s*\(\s*void\s*\)\s*excludePocketAiModelDirectoryFromBackup\b/;
const SWIFT_EXPECTED_DIRECTORY_LIST_REGEX = /\bbackupExcludedDirectoryNames\s*=\s*\[\s*"models"\s*,\s*"chat-attachments"\s*\]/;
const OBJC_EXPECTED_DIRECTORY_LIST_REGEX = /\bbackupExcludedDirectoryNames\s*=\s*@\[\s*@"models"\s*,\s*@"chat-attachments"\s*\]/;

function insertBeforeLastOccurrence(contents, needle, insertion) {
  const index = contents.lastIndexOf(needle);
  if (index < 0) {
    return contents;
  }

  return `${contents.slice(0, index)}${insertion}${contents.slice(index)}`;
}

function ensureSwiftFoundationImport(contents) {
  if (/^import\s+Foundation\b/m.test(contents)) {
    return contents;
  }

  const importPattern = /^import\s+[^\n]+/gm;
  let lastImport = null;
  let match = importPattern.exec(contents);
  while (match) {
    lastImport = match;
    match = importPattern.exec(contents);
  }

  if (!lastImport) {
    return `import Foundation\n${contents}`;
  }

  const insertIndex = lastImport.index + lastImport[0].length;
  return `${contents.slice(0, insertIndex)}\nimport Foundation${contents.slice(insertIndex)}`;
}

function findBalancedMethodBlock(contents, signatureRegex) {
  const match = signatureRegex.exec(contents);
  if (!match) {
    return null;
  }

  const openBraceIndex = contents.indexOf('{', match.index + match[0].length);
  if (openBraceIndex < 0) {
    return null;
  }

  let depth = 0;
  for (let index = openBraceIndex; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const lineStartIndex = contents.lastIndexOf('\n', match.index - 1);
        const start = lineStartIndex >= 0 ? lineStartIndex : match.index;
        return {
          start,
          end: index + 1,
          block: contents.slice(start, index + 1),
        };
      }
    }
  }

  return null;
}

function hasSwiftChatAttachmentBackupExclusion(methodBlock) {
  return SWIFT_EXPECTED_DIRECTORY_LIST_REGEX.test(methodBlock)
    && methodBlock.includes('appendingPathComponent(directoryName, isDirectory: true)')
    && methodBlock.includes('isExcludedFromBackup = true');
}

function hasObjcChatAttachmentBackupExclusion(methodBlock) {
  return OBJC_EXPECTED_DIRECTORY_LIST_REGEX.test(methodBlock)
    && methodBlock.includes('URLByAppendingPathComponent:directoryName isDirectory:YES')
    && methodBlock.includes('NSURLIsExcludedFromBackupKey');
}

function ensureSwiftBackupExclusionMethod(contents) {
  if (!SWIFT_METHOD_SIGNATURE_REGEX.test(contents)) {
    return insertBeforeLastOccurrence(contents, '\n}', SWIFT_METHOD_BLOCK);
  }

  const methodBlock = findBalancedMethodBlock(contents, SWIFT_METHOD_SIGNATURE_REGEX);
  if (!methodBlock) {
    return contents;
  }

  if (hasSwiftChatAttachmentBackupExclusion(methodBlock.block)) {
    return contents;
  }

  return `${contents.slice(0, methodBlock.start)}${SWIFT_METHOD_BLOCK}${contents.slice(methodBlock.end)}`;
}

function addSwiftBackupExclusion(contents) {
  let nextContents = ensureSwiftFoundationImport(contents);

  if (!nextContents.includes(SWIFT_CALL_MARKER)) {
    nextContents = nextContents.replace(
      /(\n\s*return\s+super\.application\(application,\s*didFinishLaunchingWithOptions:\s*launchOptions\))/,
      `\n${SWIFT_CALL_BLOCK}$1`,
    );
  }

  nextContents = ensureSwiftBackupExclusionMethod(nextContents);

  return nextContents;
}

function ensureObjcBackupExclusionMethod(contents) {
  if (!OBJC_METHOD_SIGNATURE_REGEX.test(contents)) {
    return insertBeforeLastOccurrence(contents, '\n@end', OBJC_METHOD_BLOCK);
  }

  const methodBlock = findBalancedMethodBlock(contents, OBJC_METHOD_SIGNATURE_REGEX);
  if (!methodBlock) {
    return contents;
  }

  if (hasObjcChatAttachmentBackupExclusion(methodBlock.block)) {
    return contents;
  }

  return `${contents.slice(0, methodBlock.start)}${OBJC_METHOD_BLOCK}${contents.slice(methodBlock.end)}`;
}

function addObjcBackupExclusion(contents) {
  let nextContents = contents;

  if (!nextContents.includes(OBJC_CALL_MARKER)) {
    nextContents = nextContents.replace(
      /(\n\s*return\s+(?:\[super application:application didFinishLaunchingWithOptions:launchOptions\]|YES);)/,
      `\n${OBJC_CALL_BLOCK}$1`,
    );
  }

  nextContents = ensureObjcBackupExclusionMethod(nextContents);

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
