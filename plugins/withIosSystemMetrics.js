const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins');

const SYSTEM_METRICS_MODULE_NAME = 'SystemMetrics';
const IOS_SOURCE_FILE = `${SYSTEM_METRICS_MODULE_NAME}.m`;

function normalizePbxPath(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.replace(/"/g, '').replace(/\\/g, '/');
}

function hasIosSourceFile(project, filePath) {
  if (!project) {
    return false;
  }

  if (typeof project.hasFile === 'function') {
    try {
      return Boolean(project.hasFile(filePath));
    } catch {
      // Fall through to manual detection.
    }
  }

  if (typeof project.pbxFileReferenceSection !== 'function') {
    return false;
  }

  const section = project.pbxFileReferenceSection();
  if (!section || typeof section !== 'object') {
    return false;
  }

  const normalizedTarget = normalizePbxPath(filePath);
  const normalizedBasename = normalizePbxPath(path.basename(filePath));

  for (const key of Object.keys(section)) {
    const entry = section[key];
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const normalizedEntryPath = normalizePbxPath(entry.path);
    if (!normalizedEntryPath) {
      continue;
    }

    if (normalizedTarget && normalizedEntryPath === normalizedTarget) {
      return true;
    }

    if (normalizedBasename && normalizedEntryPath === normalizedBasename) {
      return true;
    }
  }

  return false;
}

function createIosSystemMetricsSource() {
  return `#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <mach/mach.h>
#import <mach/mach_host.h>
#import <os/proc.h>

@interface ${SYSTEM_METRICS_MODULE_NAME} : NSObject <RCTBridgeModule>
@end

@implementation ${SYSTEM_METRICS_MODULE_NAME}

RCT_EXPORT_MODULE(${SYSTEM_METRICS_MODULE_NAME});

RCT_REMAP_METHOD(getMemorySnapshot,
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    uint64_t totalBytes = [NSProcessInfo processInfo].physicalMemory;

    vm_size_t pageSize = 0;
    kern_return_t pageSizeKr = host_page_size(mach_host_self(), &pageSize);

    vm_statistics64_data_t vmstat;
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    kern_return_t vmKr = host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vmstat, &count);
    BOOL hasVmInfo = (pageSizeKr == KERN_SUCCESS && vmKr == KERN_SUCCESS && pageSize > 0);

    uint64_t freeBytes = 0;
    uint64_t inactiveBytes = 0;
    uint64_t speculativeBytes = 0;
    if (hasVmInfo) {
      freeBytes = (uint64_t)vmstat.free_count * (uint64_t)pageSize;
      inactiveBytes = (uint64_t)vmstat.inactive_count * (uint64_t)pageSize;
      speculativeBytes = (uint64_t)vmstat.speculative_count * (uint64_t)pageSize;
    }

    uint64_t availableBytes = 0;
    uint64_t usedBytes = 0;
    if (hasVmInfo) {
      availableBytes = freeBytes + inactiveBytes + speculativeBytes;
      if (totalBytes > 0 && availableBytes > totalBytes) {
        availableBytes = totalBytes;
      }
      usedBytes = totalBytes > availableBytes ? (totalBytes - availableBytes) : 0;
    }

    task_basic_info_data_t taskInfo;
    mach_msg_type_number_t taskCount = TASK_BASIC_INFO_COUNT;
    kern_return_t taskKr = task_info(mach_task_self(), TASK_BASIC_INFO, (task_info_t)&taskInfo, &taskCount);
    uint64_t appResidentBytes = taskKr == KERN_SUCCESS ? (uint64_t)taskInfo.resident_size : 0;

    BOOL hasProcessAvailableBytes = NO;
    uint64_t processAvailableBytes = 0;
    if (@available(iOS 13.0, *)) {
      processAvailableBytes = os_proc_available_memory();
      hasProcessAvailableBytes = YES;
    }

    NSString *pressureLevel = @"unknown";
    BOOL lowMemory = NO;
    if (hasVmInfo && totalBytes > 0) {
      double ratio = (double)availableBytes / (double)totalBytes;
      if (ratio <= 0.08) {
        pressureLevel = @"critical";
        lowMemory = YES;
      } else if (ratio <= 0.15) {
        pressureLevel = @"warning";
      } else {
        pressureLevel = @"normal";
      }
    }

    NSTimeInterval nowSeconds = [[NSDate date] timeIntervalSince1970];
    NSNumber *timestampMs = @((long long)(nowSeconds * 1000.0));

    NSMutableDictionary *result = [@{
      @"timestampMs": timestampMs,
      @"totalBytes": @(totalBytes),
      @"availableBytes": @(availableBytes),
      @"freeBytes": @(freeBytes),
      @"usedBytes": @(usedBytes),
      @"appUsedBytes": @(appResidentBytes),
      @"appResidentBytes": @(appResidentBytes),
      @"lowMemory": @(lowMemory),
      @"pressureLevel": pressureLevel,
      @"thresholdBytes": @(0)
    } mutableCopy];

    if (hasProcessAvailableBytes) {
      result[@"processAvailableBytes"] = @(processAvailableBytes);
    }

    resolve(result);
  }
  @catch (NSException *exception) {
    reject(@"E_SYSTEM_METRICS", @"Failed to read iOS system memory metrics", nil);
  }
}

@end
`;
}

function writeIosSystemMetricsFiles(projectRoot, projectName) {
  const iosRoot = path.join(projectRoot, 'ios');
  if (!fs.existsSync(iosRoot)) {
    return;
  }

  const appDirectory = path.join(iosRoot, projectName);
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(appDirectory, IOS_SOURCE_FILE),
    createIosSystemMetricsSource(),
  );
}

function withIosSystemMetricsSourceFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (nextConfig) => {
      if (nextConfig.modRequest.introspect) {
        return nextConfig;
      }

      const projectName = nextConfig.modRequest.projectName;
      if (!projectName) {
        return nextConfig;
      }

      writeIosSystemMetricsFiles(nextConfig.modRequest.projectRoot, projectName);
      return nextConfig;
    },
  ]);
}

function withIosSystemMetricsXcodeProject(config) {
  return withXcodeProject(config, (nextConfig) => {
    const projectName = nextConfig.modRequest.projectName;
    if (!projectName) {
      return nextConfig;
    }

    const filePath = path.join(projectName, IOS_SOURCE_FILE);
    if (hasIosSourceFile(nextConfig.modResults, filePath)) {
      return nextConfig;
    }

    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: filePath,
      groupName: projectName,
      project: nextConfig.modResults,
    });

    return nextConfig;
  });
}

function withIosSystemMetrics(config) {
  config = withIosSystemMetricsSourceFiles(config);
  config = withIosSystemMetricsXcodeProject(config);
  return config;
}

withIosSystemMetrics._internal = {
  createIosSystemMetricsSource,
};

module.exports = withIosSystemMetrics;
