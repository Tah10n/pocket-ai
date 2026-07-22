const withAndroidSystemMetrics = require('../../plugins/withAndroidSystemMetrics');
const withIosSystemMetrics = require('../../plugins/withIosSystemMetrics');

describe('SystemMetrics config plugins', () => {
  it('generates Android metrics code with budgetable total memory and separate advertised memory', () => {
    const source = withAndroidSystemMetrics._internal.createSystemMetricsModuleSource('com.example.app');

    expect(source).toContain('val totalBytes = memoryInfo.totalMem.coerceAtLeast(0L)');
    expect(source).toContain('val advertisedMemoryBytes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)');
    expect(source).toContain('readProcMemInfoBytes("MemFree:")');
    expect(source).toContain('putDouble("advertisedMemoryBytes", advertisedMemoryBytes.toDouble())');
    expect(source).toContain('hasPressureRatio && pressureRatio <= 0.15 -> "warning"');
    expect(source).toContain('fun getCacheDirectorySize(promise: Promise)');
    expect(source).toContain('storageMetricsExecutor.execute');
    expect(source).toContain('readClearableCacheDirectorySizeBytes(');
    expect(source).toContain('val protectedRootNames = setOf("http-cache")');
  });

  it('bounds and cancels Android cache traversal without following symlinks or queuing scans', () => {
    const source = withAndroidSystemMetrics._internal.createSystemMetricsModuleSource('com.example.app');

    expect(source).not.toContain('walkTopDown');
    expect(source).not.toContain('newSingleThreadExecutor');
    expect(source).not.toContain('listFiles()');
    expect(source).toContain('CACHE_DIRECTORY_MAX_VISITED_NODES = 4_096');
    expect(source).toContain('CACHE_DIRECTORY_MAX_DEPTH = 64');
    expect(source).toContain('CACHE_DIRECTORY_MAX_ELAPSED_MS = 2_000L');
    expect(source).toContain('SynchronousQueue<Runnable>()');
    expect(source).toContain('ThreadPoolExecutor.AbortPolicy()');
    expect(source).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.O');
    expect(source).toContain('Files.newDirectoryStream(node.directory.toPath()).use');
    expect(source).toContain('Thread.currentThread().isInterrupted');
    expect(source).toContain('cacheDirectorySizeGeneration.get() != generation');
    expect(source).toContain('Files.isSymbolicLink(entryPath)');
    expect(source).toContain('LinkOption.NOFOLLOW_LINKS');
    expect(source).toContain('val canonicalEntry = entryPath.toFile().canonicalFile');
    expect(source).toContain('expectedPath != canonicalPath || !canonicalPath.startsWith(rootPrefix)');
    expect(source).toContain('seenDirectoryPaths.add(canonicalPath)');
    expect(source).toContain('fun invalidateCacheDirectorySizeMeasurement()');
    expect(source).toContain('activeCacheDirectorySizeThread.get()?.interrupt()');
    expect(source).toContain('catch (error: RejectedExecutionException)');
    expect(source).toContain('"E_SYSTEM_METRICS_BUSY"');
    expect(source).toContain('"E_SYSTEM_METRICS_CANCELLED"');
    expect(source).toContain('"E_SYSTEM_METRICS_LIMIT"');
    expect(source).toContain('"E_SYSTEM_METRICS_UNAVAILABLE"');
  });

  it('generates iOS metrics code with a process-specific availability signal', () => {
    const source = withIosSystemMetrics._internal.createIosSystemMetricsSource();

    expect(source).toContain('#import <os/proc.h>');
    expect(source).toContain('uint64_t processAvailableBytesCandidate = os_proc_available_memory();');
    expect(source).toContain('if (processAvailableBytesCandidate > 0)');
    expect(source).toContain('result[@"processAvailableBytes"] = @(processAvailableBytes);');
  });
});
