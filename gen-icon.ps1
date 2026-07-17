# Generates icon.ico for Perch from logo.png (the cute bird) - JUST the bird
# on a transparent background at every icon size (no card: taskbars and tabs
# already give icons their own backdrop, a baked-in card looks like a sticker).
Add-Type -AssemblyName System.Drawing

$logoPath = Join-Path $PSScriptRoot 'logo.png'
if (-not (Test-Path -LiteralPath $logoPath)) { throw "logo.png not found next to gen-icon.ps1" }
$logo = [System.Drawing.Image]::FromFile($logoPath)

# find the bird's bounding box on a small thumbnail (fast), scale up
$probe = 100
$thumb = New-Object System.Drawing.Bitmap($logo, $probe, $probe)
$minX = $probe; $minY = $probe; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $probe; $y++) {
    for ($x = 0; $x -lt $probe; $x++) {
        if ($thumb.GetPixel($x, $y).A -gt 20) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
$thumb.Dispose()
$sx = $logo.Width / $probe
$sy = $logo.Height / $probe
$srcRect = New-Object System.Drawing.RectangleF(
    [float]($minX * $sx), [float]($minY * $sy),
    [float](($maxX - $minX + 1) * $sx), [float](($maxY - $minY + 1) * $sy))
"bird bbox: $([int]$srcRect.Width)x$([int]$srcRect.Height) at $([int]$srcRect.X),$([int]$srcRect.Y)"

function New-IconPngBytes([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # bird only, centered, ~96% of the canvas - transparent background
    $inner = [float]($Size * 0.96)
    $scale = [Math]::Min($inner / $srcRect.Width, $inner / $srcRect.Height)
    $dw = [float]($srcRect.Width * $scale)
    $dh = [float]($srcRect.Height * $scale)
    $dx = [float](($Size - $dw) / 2)
    $dy = [float](($Size - $dh) / 2)
    $dest = New-Object System.Drawing.RectangleF($dx, $dy, $dw, $dh)
    $g.DrawImage($logo, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $bytes = $ms.ToArray()
    $ms.Dispose()
    return , $bytes
}

$sizes = @(16, 24, 32, 48, 64, 256)
$images = @()
foreach ($s in $sizes) { $images += , (New-IconPngBytes $s) }
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'icon-preview.png'), (New-IconPngBytes 128))
$logo.Dispose()

$outPath = Join-Path $PSScriptRoot 'icon.ico'
$fs = [System.IO.File]::Create($outPath)
$bw2 = New-Object System.IO.BinaryWriter($fs)
$bw2.Write([uint16]0)
$bw2.Write([uint16]1)
$bw2.Write([uint16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $b = $images[$i]
    $bw2.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
    $bw2.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
    $bw2.Write([byte]0)
    $bw2.Write([byte]0)
    $bw2.Write([uint16]1)
    $bw2.Write([uint16]32)
    $bw2.Write([uint32]$b.Length)
    $bw2.Write([uint32]$offset)
    $offset += $b.Length
}
foreach ($b in $images) { $bw2.Write($b) }
$bw2.Close()
$fs.Close()

"icon written: $outPath ($([int]((Get-Item $outPath).Length / 1KB))KB)"
