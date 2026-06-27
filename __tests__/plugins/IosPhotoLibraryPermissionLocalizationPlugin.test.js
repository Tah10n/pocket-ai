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

  function createXcodeProjectFixture() {
    const groups = new Map();
    const fileReferences = {
      EN_STALE_REF: {
        isa: 'PBXFileReference',
        lastKnownFileType: 'text.plist.strings',
        name: 'InfoPlist.strings',
        path: 'en.lproj/InfoPlist.strings',
        sourceTree: '<group>',
      },
    };
    const buildFiles = {};
    const resourcesBuildPhase = {
      isa: 'PBXResourcesBuildPhase',
      files: [],
    };
    const pbxProject = {
      isa: 'PBXProject',
      knownRegions: ['"en"', 'Base'],
    };
    const project = {
      pbxFileReferenceSection: jest.fn(() => fileReferences),
      pbxProjectSection: jest.fn(() => ({
        PROJECT: pbxProject,
        PROJECT_COMMENT: 'PBXProject',
      })),
    };

    const ensureGroupRecursively = jest.fn((_project, groupName) => {
      if (!groups.has(groupName)) {
        groups.set(groupName, {
          isa: 'PBXGroup',
          name: path.posix.basename(groupName),
          path: groupName,
          sourceTree: '<group>',
          children: [],
        });
      }

      return groups.get(groupName);
    });
    ensureGroupRecursively(project, 'PocketAI/Supporting/en.lproj').children.push({
      value: 'EN_STALE_REF',
      comment: 'InfoPlist.strings',
    });

    const addResourceFileToGroup = jest.fn(({
      filepath,
      groupName,
      project: nextProject,
      isBuildFile,
    }) => {
      const group = ensureGroupRecursively(nextProject, groupName);
      const fileRef = `FILE_REF_${Object.keys(fileReferences).length + 1}`;
      fileReferences[fileRef] = {
        isa: 'PBXFileReference',
        lastKnownFileType: 'text.plist.strings',
        name: path.posix.basename(filepath),
        path: filepath,
        sourceTree: '<group>',
      };
      group.children.push({
        value: fileRef,
        comment: path.posix.basename(filepath),
      });

      if (isBuildFile) {
        const buildFile = `BUILD_FILE_${Object.keys(buildFiles).length + 1}`;
        buildFiles[buildFile] = {
          isa: 'PBXBuildFile',
          fileRef,
          fileRef_comment: path.posix.basename(filepath),
        };
        resourcesBuildPhase.files.push({
          value: buildFile,
          comment: `${path.posix.basename(filepath)} in Resources`,
        });
      }

      return nextProject;
    });

    return {
      project,
      xcodeUtils: {
        ensureGroupRecursively,
        addResourceFileToGroup,
      },
      sections: {
        buildFiles,
        fileReferences,
        pbxProject,
        resourcesBuildPhase,
      },
      groups,
    };
  }

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
    expect(LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS.en).toContain('attach images');
    expect(LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS.ru).toContain('медиатеку');
    expect(LOCALIZED_PHOTO_LIBRARY_USAGE_DESCRIPTIONS.ru).toContain('прикреплять изображения');
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
      'PocketAI/Supporting/en.lproj/InfoPlist.strings',
    );
    expect(path.relative(platformProjectRoot, russianPath).replace(/\\/g, '/')).toBe(
      'PocketAI/Supporting/ru.lproj/InfoPlist.strings',
    );
    expect(getLocalizedInfoPlistStringsResourceFilepath(projectName, 'en')).toBe(
      'InfoPlist.strings',
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
      filepath: 'InfoPlist.strings',
      groupName: 'PocketAI/Supporting/en.lproj',
      isBuildFile: true,
    }));
    expect(addResourceFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'InfoPlist.strings',
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

    expect(fileReferences.EN_REF.path).toBe('InfoPlist.strings');
    expect(addResourceFileToGroup).not.toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'InfoPlist.strings',
      groupName: 'PocketAI/Supporting/en.lproj',
    }));
    expect(addResourceFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'InfoPlist.strings',
      groupName: 'PocketAI/Supporting/ru.lproj',
    }));
  });

  it('registers real-ish Xcode resources idempotently while repairing stale localized paths', () => {
    const { project, xcodeUtils, sections, groups } = createXcodeProjectFixture();

    expect(addLocalizedPhotoLibraryPermissionResourcesToProject({
      project,
      projectName: 'PocketAI',
      xcodeUtils,
    })).toBe(project);

    expect(sections.pbxProject.knownRegions).toEqual(['"en"', 'Base', 'ru']);
    expect(sections.fileReferences.EN_STALE_REF.path).toBe(
      'InfoPlist.strings',
    );
    expect(xcodeUtils.addResourceFileToGroup).toHaveBeenCalledTimes(1);
    expect(xcodeUtils.addResourceFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
      filepath: 'InfoPlist.strings',
      groupName: 'PocketAI/Supporting/ru.lproj',
      isBuildFile: true,
    }));

    const countsAfterFirstRun = {
      buildFiles: Object.keys(sections.buildFiles).length,
      fileReferences: Object.keys(sections.fileReferences).length,
      resources: sections.resourcesBuildPhase.files.length,
      ruChildren: groups.get('PocketAI/Supporting/ru.lproj').children.length,
    };

    expect(addLocalizedPhotoLibraryPermissionResourcesToProject({
      project,
      projectName: 'PocketAI',
      xcodeUtils,
    })).toBe(project);

    expect(xcodeUtils.addResourceFileToGroup).toHaveBeenCalledTimes(1);
    expect(Object.keys(sections.buildFiles)).toHaveLength(countsAfterFirstRun.buildFiles);
    expect(Object.keys(sections.fileReferences)).toHaveLength(countsAfterFirstRun.fileReferences);
    expect(sections.resourcesBuildPhase.files).toHaveLength(countsAfterFirstRun.resources);
    expect(groups.get('PocketAI/Supporting/en.lproj').children).toHaveLength(1);
    expect(groups.get('PocketAI/Supporting/ru.lproj').children).toHaveLength(
      countsAfterFirstRun.ruChildren,
    );
    expect(sections.pbxProject.knownRegions).toEqual(['"en"', 'Base', 'ru']);
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
