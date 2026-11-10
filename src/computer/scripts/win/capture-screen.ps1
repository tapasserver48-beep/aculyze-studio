# Zara Computer Control — screen capture on Windows (FIXED script).
# Copies the primary screen to a PNG using System.Drawing (no external tools).
# The output path is passed as a PARAMETER (never interpolated as code).
param(
  [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'

# Only allow writing a .png under the system temp directory (defence in depth).
# Node passes os.tmpdir() which may be an 8.3 short path (e.g. SPLPT1~1), so we
# resolve the directory to its long form before comparing.
$outDir = [System.IO.Path]::GetDirectoryName($OutPath)
$resolvedOutDir = (Get-Item -LiteralPath $outDir).FullName
$resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
if (-not $resolvedOutDir.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or $OutPath -notlike '*.png') {
  Write-Output ('{"done":false,"error":"invalid output path"}')
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()

$fi = Get-Item -LiteralPath $OutPath
$result = [ordered]@{
  done   = $true
  op     = 'screen.capture'
  path   = $fi.FullName
  bytes  = $fi.Length
  width  = $bounds.Width
  height = $bounds.Height
}
Write-Output ($result | ConvertTo-Json -Compress)
