const fs = require('fs');
const os = require('os');
const path = require('path');
const withIosPhotoLibraryPermissionLocalization = require('../../plugins/withIosPhotoLibraryPermissionLocalization');

describe('iOS photo library permission localization config plugin', () => {
  const {
    PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY,
    LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS,
    addLocalizedPhotoLibraryPermissionResourcesToProject,
    buildInfoPlistStringsContent,
    ensureKnownRegions,
    escapeInfoPlistString,
    getLocalizedInfoPlistStringsResourceFilepath,
    resolveIosProjectName,
    updateInfoPlistStringsContent,
    writeLocalizedPhotoLibraryPermissionFiles,
  } = withIosPhotoLibraryPermissionLocalization._internal;

  it('builds escaped InfoPlist.strings entries', () => {
    expect(escapeInfoPlistString('Path "A"\\B\nnext')).toBe('Path \\"A\\"\\\\B\\nnext');
    expect(buildInfoPlistStringsContent({
      [PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY]: 'Use "Photos" safely.',
    })).toBe('"NSPhotoLibraryUsageDescription" = "Use \\"Photos\\" safely.";\n');
  });

  it('preserves unrelated InfoPlist.strings entries when inserting the photo permission copy', () => {
    const existingContent = [
      '/* App display name */',
      '"CFBundleDisplayName" = "Pocket AI";',
      '',
    ].join('\n');

    const result = updateInfoPlistStringsContent(existingContent, {
      [PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY]: 'Use photos safely.',
    });

    expect(result).toContain('/* App display name */');
    expect(result).toContain('"CFBundleDisplayName" = "Pocket AI";');
    expect(result).toContain('"NSPhotoLibraryUsageDescription" = "Use photos safely.";');
  });

  it('updates only an existing photo permission entry', () => {
    const result = updateInfoPlistStringsContent([
      '"CFBundleDisplayName" = "Pocket AI";',
      '"NSPhotoLibraryUsageDescription" = "Old photos copy"; /* keep trailing comment */',
      '"UILaunchStoryboardName" = "SplashScreen";',
    ].join('\n'), {
      [PHOTO_LIBRARY_USAGE_DESCRIPTION_KEY]: 'Use "Photos" safely.',
    });

    expect(result).toContain('"CFBundleDisplayName" = "Pocket AI";');
    expect(result).toContain('"UILaunchStoryboardName" = "SplashScreen";');
    expect(result).toContain(
      '"NSPhotoLibraryUsageDescription" = "Use \\"Photos\\" safely."; /* keep trailing comment */'
    );
    expect(result).not.toContain('Old photos copy');
    expect((result.match(/NSPhotoLibraryUsageDescription/g) || []).length).toBe(1);
  });

  it('ships English and Russian photo permission copy', () => {
    expect(LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS.en).toContain('photo library');
    expect(LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS.ru).toContain('медиатеку');
  });

  it('resolves the Expo iOS project name with a safe fallback', () => {
    expect(resolveIosProjectName({ name: 'Pocket AI' }, { projectName: 'PocketAI' })).toBe('PocketAI');
    expect(resolveIosProjectName({ name: 'Pocket AI' }, {})).toBe('PocketAI');
  });

  it('writes localized InfoPlist.strings files into locale resource directories', () => {
    const platformProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-ios-permissions-'));
    const projectName = 'PocketAI';

    writeLocalizedPhotoLibraryPermissionFiles({ platformProjectRoot, projectName });

    const englishPath = path.join(platformProjectRoot, projectName, 'Supporting', 'en.lproj', 'InfoPlist.strings');
    const russianPath = path.join(platformProjectRoot, projectName, 'Supporting', 'ru.lproj', 'InfoPlist.strings');
    const english = fs.readFileSync(englishPath, 'utf8');
    const russian = fs.readFileSync(russianPath, 'utf8');

    expect(english).toContain('NSPhotoLibraryUsageDescription');
    expect(english).toContain('photo library');
    expect(russian).toContain('NSPhotoLibraryUsageDescription');
    expect(russian).toContain('медиатеку');
    expect(path.relative(platformProjectRoot, englishPath).replace(/\\/g, '/')).toBe(
      getLocalizedInfoPlistStringsResourceFilepath(projectName, 'en'),
    );
    expect(path.relative(platformProjectRoot, russianPath).replace(/\\/g, '/')).toBe(
      getLocalizedInfoPlistStringsResourceFilepath(projectName, 'ru'),
    );
  });

  it('preserves existing localized entries while writing permission files', () => {
    const platformProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-ios-permissions-'));
    const projectName = 'PocketAI';
    const localeDirectory = path.join(platformProjectRoot, projectName, 'Supporting', 'en.lproj');
    fs.mkdirSync(localeDirectory, { recursive: true });
    fs.writeFileSync(path.join(localeDirectory, 'InfoPlist.strings'), [
      '"CFBundleDisplayName" = "Pocket AI";',
      '"NSPhotoLibraryUsageDescription" = "Old photos copy";',
    ].join('\n'));

    writeLocalizedPhotoLibraryPermissionFiles({
      platformProjectRoot,
      projectName,
      descriptions: { en: 'Updated photos copy.' },
    });

    const english = fs.readFileSync(
      path.join(localeDirectory, 'InfoPlist.strings'),
      'utf8',
    );

    expect(english).toContain('"CFBundleDisplayName" = "Pocket AI";');
    expect(english).toContain('"NSPhotoLibraryUsageDescription" = "Updated photos copy.";');
    expect(english).not.toContain('Old photos copy');
    expect((english.match(/NSPhotoLibraryUsageDescription/g) || []).length).toBe(1);
  });

  it('registers localized InfoPlist.strings files as Xcode resources', () => {
    const project = { id: 'project' };
    const ensureGroupRecursively = jest.fn((_project, groupName) => ({
      children: groupName.includes('en.lproj') ? [{ comment: 'Existing.strings' }] : [],
    }));
    const addResourceFileToGroup = jest.fn(({ project: nextProject }) => nextProject);

    const result = addLocalizedPhotoLibraryPermissionResourcesToProject({
      project,
      projectName: 'PocketAI',
      xcodeUtils: {
        ensureGroupRecursively,
        addResourceFileToGroup,
      },
    });

    expect(result).toBe(project);
    expect(ensureGroupRecursively).toHaveBeenCalledWith(project, 'PocketAI/Supporting/en.lproj');
    expect(ensureGroupRecursively).toHaveBeenCalledWith(project, 'PocketAI/Supporting/ru.lproj');
    expect(addResourceFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'PocketAI/Supporting/en.lproj/InfoPlist.strings',
      groupName: 'PocketAI/Supporting/en.lproj',
      isBuildFile: true,
    }));
    expect(addResourceFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'PocketAI/Supporting/ru.lproj/InfoPlist.strings',
      groupName: 'PocketAI/Supporting/ru.lproj',
      isBuildFile: true,
    }));
  });

  it('repairs existing localized InfoPlist.strings resource paths instead of leaving stale PBX references', () => {
    const fileReferences = {
      EN_REF: {
        isa: 'PBXFileReference',
        lastKnownFileType: 'text.plist.strings',
        name: 'InfoPlist.strings',
        path: 'en.lproj/InfoPlist.strings',
        sourceTree: '<group>',
      },
    };
    const project = {
      id: 'project',
      pbxFileReferenceSection: jest.fn(() => fileReferences),
    };
    const ensureGroupRecursively = jest.fn((_project, groupName) => ({
      children: groupName.includes('en.lproj')
        ? [{ value: 'EN_REF', comment: 'InfoPlist.strings' }]
        : [],
    }));
    const addResourceFileToGroup = jest.fn(({ project: nextProject }) => nextProject);

    addLocalizedPhotoLibraryPermissionResourcesToProject({
      project,
      projectName: 'PocketAI',
      descriptions: { en: 'English copy', ru: 'Russian copy' },
      xcodeUtils: {
        ensureGroupRecursively,
        addResourceFileToGroup,
      },
    });

    expect(fileReferences.EN_REF.path).toBe('PocketAI/Supporting/en.lproj/InfoPlist.strings');
    expect(addResourceFileToGroup).not.toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'PocketAI/Supporting/en.lproj/InfoPlist.strings',
    }));
    expect(addResourceFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'PocketAI/Supporting/ru.lproj/InfoPlist.strings',
    }));
  });

  it('adds localized permission languages to Xcode known regions', () => {
    const pbxProject = {
      isa: 'PBXProject',
      knownRegions: ['en', 'Base'],
    };
    const project = {
      pbxProjectSection: jest.fn(() => ({
        PROJECT: pbxProject,
        PROJECT_COMMENT: 'PBXProject',
      })),
    };

    expect(ensureKnownRegions(project, ['en', 'ru'])).toBe(project);

    expect(pbxProject.knownRegions).toEqual(['en', 'Base', 'ru']);
  });
});
