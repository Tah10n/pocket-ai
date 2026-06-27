const fs = require('fs');
const path = require('path');
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY = 'NSPhotoLibraryUsageDescription';
const LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS = Object.freeze({
  en: 'Pocket AI uses your photo library so you can attach images to local chats.',
  ru: 'Pocket AI использует медиатеку, чтобы вы могли прикреплять изображения к локальным чатам.',
});

function escapeInfoPlistString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function buildInfoPlistStringEntry(key, value) {
  return `"${escapeInfoPlistString(key)}" = "${escapeInfoPlistString(value)}";`;
}

function buildInfoPlistStringsContent(entries) {
  return `${Object.entries(entries)
    .map(([key, value]) => buildInfoPlistStringEntry(key, value))
    .join('\n')}\n`;
}

function getInfoPlistStringsNewline(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function updateInfoPlistStringsContent(existingContent, entries) {
  let nextContent = typeof existingContent === 'string' ? existingContent : '';
  const newline = getInfoPlistStringsNewline(nextContent);

  for (const [key, value] of Object.entries(entries)) {
    const escapedKey = escapeInfoPlistString(key);
    const escapedValue = escapeInfoPlistString(value);
    let updatedExistingEntry = false;

    const nextLines = nextContent.split(/\r\n|\n/).map((line) => {
      const match = line.match(/^(\s*"((?:\\.|[^"\\])*)"\s*=\s*)"(?:\\.|[^"\\])*"(\s*;.*)$/);

      if (!match || match[2] !== escapedKey) {
        return line;
      }

      updatedExistingEntry = true;
      return `${match[1]}"${escapedValue}"${match[3]}`;
    });

    if (updatedExistingEntry) {
      nextContent = nextLines.join(newline);
      continue;
    }

    const entryLine = buildInfoPlistStringEntry(key, value);

    if (nextContent.length === 0) {
      nextContent = `${entryLine}${newline}`;
    } else if (nextContent.endsWith('\n')) {
      nextContent = `${nextContent}${entryLine}${newline}`;
    } else {
      nextContent = `${nextContent}${newline}${entryLine}${newline}`;
    }
  }

  return nextContent;
}

function resolveIosProjectName(config, modRequest) {
  return modRequest.projectName
    || config.name?.replace(/[^A-Za-z0-9_]/g, '')
    || 'PocketAI';
}

function getSupportingDirectory(platformProjectRoot, projectName) {
  return path.join(platformProjectRoot, projectName, 'Supporting');
}

function getLocalizedInfoPlistStringsResourceFilepath() {
  return 'InfoPlist.strings';
}

function writeLocalizedPhotoLibraryPermissionFiles({
  platformProjectRoot,
  projectName,
  descriptions = LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS,
}) {
  const supportingDirectory = getSupportingDirectory(platformProjectRoot, projectName);

  for (const [locale, description] of Object.entries(descriptions)) {
    const localeDirectory = path.join(supportingDirectory, `${locale}.lproj`);
    const infoPlistStringsPath = path.join(localeDirectory, 'InfoPlist.strings');
    fs.mkdirSync(localeDirectory, { recursive: true });
    const existingContent = fs.existsSync(infoPlistStringsPath)
      ? fs.readFileSync(infoPlistStringsPath, 'utf8')
      : '';

    fs.writeFileSync(infoPlistStringsPath, updateInfoPlistStringsContent(existingContent, {
      [PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY]: description,
    }));
  }
}

function addLocalizedPhotoLibraryPermissionResourcesToProject({
  project,
  projectName,
  descriptions = LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS,
  xcodeUtils = IOSConfig.XcodeUtils,
}) {
  let nextProject = project;
  nextProject = ensureKnownRegions(nextProject, Object.keys(descriptions));

  for (const locale of Object.keys(descriptions)) {
    const groupName = `${projectName}/Supporting/${locale}.lproj`;
    const group = xcodeUtils.ensureGroupRecursively(nextProject, groupName);
    const existingInfoPlistStringsChild = group?.children?.find(({ comment }) => comment === 'InfoPlist.strings');

    if (
      existingInfoPlistStringsChild
      && ensureLocalizedInfoPlistStringsResourcePath(
        nextProject,
        existingInfoPlistStringsChild,
        getLocalizedInfoPlistStringsResourceFilepath(projectName, locale),
      )
    ) {
      continue;
    }

    nextProject = xcodeUtils.addResourceFileToGroup({
      filepath: getLocalizedInfoPlistStringsResourceFilepath(projectName, locale),
      groupName,
      project: nextProject,
      isBuildFile: true,
    });
  }

  return nextProject;
}

function getPbxChildFileReferenceId(child) {
  return child?.value || child?.fileRef || child?.uuid;
}

function getPbxFileReferenceForChild(project, child) {
  if (typeof project.pbxFileReferenceSection !== 'function') {
    return undefined;
  }

  const fileReferenceId = getPbxChildFileReferenceId(child);
  if (!fileReferenceId) {
    return undefined;
  }

  return project.pbxFileReferenceSection()?.[fileReferenceId];
}

function normalizePbxPath(value) {
  return typeof value === 'string'
    ? unquotePbxValue(value).replace(/\\/g, '/')
    : undefined;
}

function ensureLocalizedInfoPlistStringsResourcePath(project, child, expectedFilepath) {
  const fileReference = getPbxFileReferenceForChild(project, child);

  if (!fileReference) {
    return typeof project.pbxFileReferenceSection !== 'function';
  }

  if (normalizePbxPath(fileReference.path) !== expectedFilepath) {
    fileReference.path = expectedFilepath;
  }

  if (fileReference.name && normalizePbxPath(fileReference.name) !== 'InfoPlist.strings') {
    fileReference.name = 'InfoPlist.strings';
  }

  return true;
}

function unquotePbxValue(value) {
  return String(value).replace(/^"(.*)"$/, '$1');
}

function ensureKnownRegions(project, locales) {
  if (typeof project.pbxProjectSection !== 'function') {
    return project;
  }

  const projectSection = project.pbxProjectSection();

  for (const sectionItem of Object.values(projectSection)) {
    if (sectionItem?.isa !== 'PBXProject' || !Array.isArray(sectionItem.knownRegions)) {
      continue;
    }

    for (const locale of locales) {
      const hasLocale = sectionItem.knownRegions.some((knownRegion) => unquotePbxValue(knownRegion) === locale);

      if (!hasLocale) {
        sectionItem.knownRegions.push(locale);
      }
    }
  }

  return project;
}

function withIosPhotoLibraryPermissionLocalization(config) {
  config = withDangerousMod(config, ['ios', (modConfig) => {
    writeLocalizedPhotoLibraryPermissionFiles({
      platformProjectRoot: modConfig.modRequest.platformProjectRoot,
      projectName: resolveIosProjectName(modConfig, modConfig.modRequest),
    });

    return modConfig;
  }]);

  config = withXcodeProject(config, (modConfig) => {
    modConfig.modResults = addLocalizedPhotoLibraryPermissionResourcesToProject({
      project: modConfig.modResults,
      projectName: resolveIosProjectName(modConfig, modConfig.modRequest),
    });

    return modConfig;
  });

  return config;
}

withIosPhotoLibraryPermissionLocalization._internal = {
  PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY,
  LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS,
  buildInfoPlistStringsContent,
  buildInfoPlistStringEntry,
  escapeInfoPlistString,
  addLocalizedPhotoLibraryPermissionResourcesToProject,
  ensureKnownRegions,
  ensureLocalizedInfoPlistStringsResourcePath,
  getLocalizedInfoPlistStringsResourceFilepath,
  getSupportingDirectory,
  resolveIosProjectName,
  updateInfoPlistStringsContent,
  writeLocalizedPhotoLibraryPermissionFiles,
};

module.exports = withIosPhotoLibraryPermissionLocalization;
