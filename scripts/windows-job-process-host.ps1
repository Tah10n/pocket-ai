param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'

$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
$payload = $payloadJson | ConvertFrom-Json
if (
    [string]::IsNullOrWhiteSpace($payload.applicationPath) -or
    [string]::IsNullOrWhiteSpace($payload.commandLine) -or
    [string]::IsNullOrWhiteSpace($payload.currentDirectory)
) {
    throw 'The Windows Job host payload is incomplete.'
}

$jobHostSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace PocketAi {
  public static class WindowsJobProcessHost {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_FAILED = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO {
      public uint cb;
      public IntPtr lpReserved;
      public IntPtr lpDesktop;
      public IntPtr lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      uint informationLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void DebugLog(string message) {
      if (Environment.GetEnvironmentVariable("POCKET_AI_JOB_HOST_DEBUG") == "1") {
        Console.Error.WriteLine("[windows-job-host:debug] " + message);
        Console.Error.Flush();
      }
    }

    private static void ConfigureKillOnClose(IntPtr job) {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr pointer = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, pointer, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure the Windows Job Object.");
        }
      } finally {
        Marshal.FreeHGlobal(pointer);
      }
    }

    public static void Run(string applicationPath, string commandLine, string currentDirectory) {
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) {
        Console.Error.WriteLine("[windows-job-host] Could not create the Windows Job Object: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        Environment.Exit(1);
      }

      try {
        ConfigureKillOnClose(job);
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
          throw new Win32Exception(
            Marshal.GetLastWin32Error(),
            "Could not place the Windows Job host inside its ownership boundary."
          );
        }
        DebugLog("host assigned to kill-on-close Job");

        var startupInfo = new STARTUPINFO();
        startupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startupInfo.dwFlags = STARTF_USESTDHANDLES;
        startupInfo.hStdInput = GetStdHandle(-10);
        startupInfo.hStdOutput = GetStdHandle(-11);
        startupInfo.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION processInformation;

        if (!CreateProcess(
          applicationPath,
          new StringBuilder(commandLine),
          IntPtr.Zero,
          IntPtr.Zero,
          true,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
          IntPtr.Zero,
          currentDirectory,
          ref startupInfo,
          out processInformation
        )) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the owned Windows process.");
        }
        DebugLog("created suspended child PID " + processInformation.dwProcessId);

        if (ResumeThread(processInformation.hThread) == 0xffffffff) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resume the owned Windows process.");
        }
        CloseHandle(processInformation.hThread);
        if (WaitForSingleObject(processInformation.hProcess, INFINITE) == WAIT_FAILED) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not wait for the owned Windows process.");
        }
        uint exitCode;
        if (!GetExitCodeProcess(processInformation.hProcess, out exitCode)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the owned Windows process exit code.");
        }
        DebugLog("direct child exited with code " + exitCode);
        CloseHandle(processInformation.hProcess);

        // Exiting closes the final Job handle. Windows then terminates any
        // descendant that outlived the direct child and preserves its exit code.
        Environment.Exit(unchecked((int)exitCode));
      } catch (Exception error) {
        Console.Error.WriteLine("[windows-job-host] " + error.Message);
        Environment.Exit(1);
      }
    }
  }
}
'@

Add-Type -TypeDefinition $jobHostSource -ErrorAction Stop
[PocketAi.WindowsJobProcessHost]::Run(
    [string]$payload.applicationPath,
    [string]$payload.commandLine,
    [string]$payload.currentDirectory
)
