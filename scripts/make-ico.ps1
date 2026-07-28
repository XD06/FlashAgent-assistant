# Rebuild build/icon.ico from build/icon.png with all standard sizes.
# Windows Explorer needs 16/24/32/48 entries; a single-256 ico renders blank.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'build\icon.png'
$dst = Join-Path $root 'build\icon.ico'
$sizes = 16, 24, 32, 48, 64, 128, 256

$img = [System.Drawing.Image]::FromFile($src)
$pngs = foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  , $ms.ToArray()
}
$img.Dispose()

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($out)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim); $w.Write([byte]$dim)   # width, height (0 = 256)
  $w.Write([byte]0); $w.Write([byte]0)          # palette, reserved
  $w.Write([uint16]1); $w.Write([uint16]32)     # planes, bpp
  $w.Write([uint32]$pngs[$i].Length)
  $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[System.IO.File]::WriteAllBytes($dst, $out.ToArray())
$w.Dispose()
Write-Host "Wrote $dst ($([System.IO.FileInfo]::new($dst).Length) bytes, $($sizes.Count) sizes)"
