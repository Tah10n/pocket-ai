param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [long]$StartMarker
)

$ErrorActionPreference = 'Stop'

$stopSource = @'
using System;
using System.Runtime.InteropServices;

namespace PocketAi {
  public static class WindowsJobProcessStop {
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
      public uint LowDateTime;
      public uint HighDateTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(
      IntPtr process,
      out FILETIME creationTime,
      out FILETIME exitTime,
      out FILETIME kernelTime,
      out FILETIME userTime
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static long ToDateTimeTicks(FILETIME value) {
      long fileTime = ((long)value.HighDateTime << 32) | value.LowDateTime;
      return DateTime.FromFileTimeUtc(fileTime).Ticks;
    }

    public static int Run(int processId, long expectedStartMarker) {
      IntPtr process = OpenProcess(
        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
        false,
        processId
      );
      if (process == IntPtr.Zero) {
        // The authenticated Job host has already exited, so Windows has closed
        // its kill-on-close Job and no owned descendant can remain.
        return Marshal.GetLastWin32Error() == 87 ? 0 : 42;
      }

      try {
        FILETIME creationTime;
        FILETIME exitTime;
        FILETIME kernelTime;
        FILETIME userTime;
        if (!GetProcessTimes(process, out creationTime, out exitTime, out kernelTime, out userTime)) {
          return 44;
        }
        if (ToDateTimeTicks(creationTime) != expectedStartMarker) {
          // This handle belongs to a reused PID, not to the owned Job host.
          return 0;
        }
        if (!TerminateProcess(process, 1)) {
          return WaitForSingleObject(process, 0) == WAIT_OBJECT_0 ? 0 : 43;
        }
        uint waitResult = WaitForSingleObject(process, 5000);
        if (waitResult == WAIT_OBJECT_0) {
          return 0;
        }
        return waitResult == WAIT_TIMEOUT ? 45 : 46;
      } finally {
        CloseHandle(process);
      }
    }
  }
}
'@

Add-Type -TypeDefinition $stopSource -ErrorAction Stop
$exitCode = [PocketAi.WindowsJobProcessStop]::Run($ProcessId, $StartMarker)
exit $exitCode
