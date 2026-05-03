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
  });

  it('generates iOS metrics code with a process-specific availability signal', () => {
    const source = withIosSystemMetrics._internal.createIosSystemMetricsSource();

    expect(source).toContain('#import <os/proc.h>');
    expect(source).toContain('uint64_t processAvailableBytesCandidate = os_proc_available_memory();');
    expect(source).toContain('if (processAvailableBytesCandidate > 0)');
    expect(source).toContain('result[@"processAvailableBytes"] = @(processAvailableBytes);');
  });
});
