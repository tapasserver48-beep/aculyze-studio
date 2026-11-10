# Zara Computer Control — "Show desktop" on Windows (FIXED script).
# Synthesizes the Win+D chord via user32 keybd_event — the standard native
# mechanism for this single, explicitly-whitelisted operation. No user input
# is ever interpolated into this script.
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZaraDesktop {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const byte VK_LWIN = 0x5B;
  public const byte VK_D = 0x44;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static void ShowDesktop() {
    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
    keybd_event(VK_D, 0, 0, UIntPtr.Zero);
    keybd_event(VK_D, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

[ZaraDesktop]::ShowDesktop()
Write-Output '{"done":true,"op":"desktop.show"}'
