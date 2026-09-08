const withAndroidGradleJvmMemory = require('../../plugins/withAndroidGradleJvmMemory');

describe('Android Gradle JVM memory config plugin', () => {
  const { ANDROID_GRADLE_JVM_ARGS, ensureAndroidGradleJvmMemory } = withAndroidGradleJvmMemory._internal;

  it('raises generated Gradle metaspace without increasing the heap ceiling', () => {
    const properties = [
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx2048m -XX:MaxMetaspaceSize=512m',
      },
    ];

    expect(ensureAndroidGradleJvmMemory(properties)).toBe(properties);
    expect(properties).toContainEqual({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: ANDROID_GRADLE_JVM_ARGS,
    });
    expect(ANDROID_GRADLE_JVM_ARGS).toBe('-Xmx2048m -XX:MaxMetaspaceSize=1024m');
  });

  it('adds the Gradle JVM contract once when the generated property is missing', () => {
    const properties = [{ type: 'property', key: 'org.gradle.parallel', value: 'true' }];

    ensureAndroidGradleJvmMemory(properties);
    ensureAndroidGradleJvmMemory(properties);

    expect(properties.filter((property) => property.key === 'org.gradle.jvmargs')).toEqual([
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: ANDROID_GRADLE_JVM_ARGS,
      },
    ]);
  });
});
