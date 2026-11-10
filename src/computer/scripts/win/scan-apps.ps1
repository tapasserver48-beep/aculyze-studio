# Zara Computer Control — installed-app discovery scan (FIXED script).
# Scans the Start Menu for .lnk shortcuts and resolves their real targets,
# plus the "App Paths" registry. Outputs one JSON array. No user input.
$ErrorActionPreference = 'SilentlyContinue'

$dirs = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)

$ws = New-Object -ComObject WScript.Shell
$entries = @()

foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $s = $ws.CreateShortcut($_.FullName)
      if ($s.TargetPath -and (Test-Path $s.TargetPath -PathType Leaf)) {
        $entries += [PSCustomObject]@{
          name    = $_.BaseName
          target  = $s.TargetPath
          source  = 'start-menu'
        }
      }
    } catch { }
  }
}

# App Paths registry (per-machine launch registrations)
$apKeys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\*'
)
foreach ($k in $apKeys) {
  Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object {
    $exe = $_.'(default)'
    if ($exe -and (Test-Path $exe -PathType Leaf)) {
      $entries += [PSCustomObject]@{
        name   = [System.IO.Path]::GetFileNameWithoutExtension($_.PSChildName)
        target = $exe
        source = 'app-paths'
      }
    }
  }
}

Write-Output ($entries | ConvertTo-Json -Compress)
