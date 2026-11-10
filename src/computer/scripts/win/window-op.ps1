# Zara Computer Control — Windows window operations (FIXED script, never
# generated from user input). Parameters are validated by attribute regexes,
# so nothing typed by a user can become executable code here.
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+(\.exe)?$')]
  [string]$ProcessName,

  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'minimize', 'maximize', 'restore', 'focus', 'close')]
  [string]$Operation
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ZaraWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static System.Collections.Generic.List<IntPtr> VisibleWindowsOf(uint pid) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string TitleOf(IntPtr h) {
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
"@

function Get-TargetWindows {
  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($ProcessName)
  $procs = @()
  try { $procs = @(Get-Process -Name $baseName -ErrorAction Stop) } catch { return @() }
  $hwnds = @()
  foreach ($p in $procs) { $hwnds += [ZaraWin]::VisibleWindowsOf([uint32]$p.Id) }
  return $hwnds
}

$hwnds = Get-TargetWindows

if ($Operation -eq 'list') {
  $items = @()
  foreach ($h in $hwnds) {
    $items += [PSCustomObject]@{
      title     = [ZaraWin]::TitleOf($h)
      minimized = [ZaraWin]::IsIconic($h)
      maximized = [ZaraWin]::IsZoomed($h)
    }
  }
  Write-Output (@{ found = ($items.Count -gt 0); windows = $items } | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

if ($hwnds.Count -eq 0) {
  Write-Output (@{ found = $false; op = $Operation } | ConvertTo-Json -Compress)
  exit 0
}

$focused = $false
foreach ($h in $hwnds) {
  switch ($Operation) {
    'minimize' { [void][ZaraWin]::ShowWindow($h, 6) }   # SW_MINIMIZE
    'maximize' { [void][ZaraWin]::ShowWindow($h, 3) }   # SW_MAXIMIZE
    'restore'  { [void][ZaraWin]::ShowWindow($h, 9) }   # SW_RESTORE
    'close'    { [void][ZaraWin]::SendMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } # WM_CLOSE (polite)
    'focus'    {
      if ([ZaraWin]::GetForegroundWindow() -ne $h) {
        # Foreground-lock workaround: attach our input thread to the target's
        # and the current foreground window's input queues, then raise it.
        [uint32]$procId = 0
        $tid = [ZaraWin]::GetWindowThreadProcessId($h, [ref]$procId)
        [uint32]$fgProc = 0
        $fgTid = [ZaraWin]::GetWindowThreadProcessId([ZaraWin]::GetForegroundWindow(), [ref]$fgProc)
        $self = [ZaraWin]::GetCurrentThreadId()
        [void][ZaraWin]::AttachThreadInput($fgTid, $self, $true)
        [void][ZaraWin]::AttachThreadInput($tid, $self, $true)
        [void][ZaraWin]::BringWindowToTop($h)
        [void][ZaraWin]::SetForegroundWindow($h)
        # foreground switches can lag a beat — poll before falling back
        for ($i = 0; $i -lt 20 -and [ZaraWin]::GetForegroundWindow() -ne $h; $i++) { Start-Sleep -Milliseconds 50 }
        [void][ZaraWin]::AttachThreadInput($tid, $self, $false)
        [void][ZaraWin]::AttachThreadInput($fgTid, $self, $false)
      }
      if ([ZaraWin]::GetForegroundWindow() -ne $h) {
        # Last-resort classic: tapping ALT re-arms SetForegroundWindow rights.
        [ZaraWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)        # ALT down
        [ZaraWin]::keybd_event(0x12, 0, 0x0002, [UIntPtr]::Zero)   # ALT up
        [void][ZaraWin]::SetForegroundWindow($h)
        for ($i = 0; $i -lt 20 -and [ZaraWin]::GetForegroundWindow() -ne $h; $i++) { Start-Sleep -Milliseconds 50 }
      }
      if ([ZaraWin]::GetForegroundWindow() -eq $h) { $focused = $true }
    }
  }
}

Write-Output (@{ found = $true; op = $Operation; focused = $focused; count = $hwnds.Count } | ConvertTo-Json -Compress)
