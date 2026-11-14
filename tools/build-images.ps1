# build-images.ps1
# Regenerates the web-optimised image assets in assets/img from the master
# artwork in ../Logo. Run from the repository root:
#   pwsh -File tools/build-images.ps1
#
# The master files are black artwork on a transparent background, so the site
# needs both a black variant (for light panels) and a white variant (for the
# deep-ocean hero). Nothing here is required at runtime; run it again only if
# the artwork changes.

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$repoRoot   = Split-Path -Parent $PSScriptRoot
$logoDir    = Join-Path (Split-Path -Parent $repoRoot) 'Logo'
$outDir     = Join-Path $repoRoot 'assets\img'
$bannerSrc  = Join-Path $logoDir 'MAELStrOM Banner Logo.png'
$markSrc    = Join-Path $logoDir 'MAELStrOM Logo.png'

if (-not (Test-Path -LiteralPath $bannerSrc)) { throw "Missing banner artwork: $bannerSrc" }
if (-not (Test-Path -LiteralPath $markSrc))   { throw "Missing mark artwork: $markSrc" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-ResizedBitmap {
    param([System.Drawing.Image]$Source, [int]$Width)
    $h = [int][Math]::Round($Source.Height * ($Width / $Source.Width))
    $bmp = New-Object System.Drawing.Bitmap($Width, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $dst = New-Object System.Drawing.Rectangle(0, 0, $Width, $h)
    $g.DrawImage($Source, $dst, 0, 0, $Source.Width, $Source.Height, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    return $bmp
}

# Re-colour every pixel that carries opacity, preserving the anti-aliasing in
# the alpha channel. Used to build white-on-dark variants of the black masters.
function New-RecolouredBitmap {
    param([System.Drawing.Bitmap]$Source, [System.Drawing.Color]$Colour)
    $w = $Source.Width; $h = $Source.Height
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $srcData = $Source.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $dstData = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $bytes = $srcData.Stride * $h
        $buffer = New-Object byte[] $bytes
        [System.Runtime.InteropServices.Marshal]::Copy($srcData.Scan0, $buffer, 0, $bytes)
        for ($i = 0; $i -lt $bytes; $i += 4) {
            # BGRA layout; only touch pixels that are at least partly visible.
            if ($buffer[$i + 3] -gt 0) {
                $buffer[$i]     = $Colour.B
                $buffer[$i + 1] = $Colour.G
                $buffer[$i + 2] = $Colour.R
            }
        }
        [System.Runtime.InteropServices.Marshal]::Copy($buffer, 0, $dstData.Scan0, $bytes)
    }
    finally {
        $Source.UnlockBits($srcData)
        $bmp.UnlockBits($dstData)
    }
    return $bmp
}

function Save-Png {
    param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("  {0}  ({1:N0} bytes, {2}x{3})" -f (Split-Path -Leaf $Path), (Get-Item -LiteralPath $Path).Length, $Bitmap.Width, $Bitmap.Height)
}

Write-Output 'Building banner variants...'
$banner = [System.Drawing.Image]::FromFile($bannerSrc)
try {
    $bannerBlack = New-ResizedBitmap -Source $banner -Width 1800
    Save-Png -Bitmap $bannerBlack -Path (Join-Path $outDir 'banner-black.png')
    $bannerWhite = New-RecolouredBitmap -Source $bannerBlack -Colour ([System.Drawing.Color]::White)
    Save-Png -Bitmap $bannerWhite -Path (Join-Path $outDir 'banner-white.png')
}
finally { $banner.Dispose() }

Write-Output 'Building mark variants...'
$mark = [System.Drawing.Image]::FromFile($markSrc)
try {
    $mark512 = New-ResizedBitmap -Source $mark -Width 512
    Save-Png -Bitmap $mark512 -Path (Join-Path $outDir 'mark-black-512.png')
    $markWhite512 = New-RecolouredBitmap -Source $mark512 -Colour ([System.Drawing.Color]::White)
    Save-Png -Bitmap $markWhite512 -Path (Join-Path $outDir 'mark-white-512.png')
    $mark192 = New-ResizedBitmap -Source $mark -Width 192
    Save-Png -Bitmap $mark192 -Path (Join-Path $outDir 'mark-black-192.png')
    $mark64 = New-ResizedBitmap -Source $mark -Width 64
    Save-Png -Bitmap $mark64 -Path (Join-Path $outDir 'favicon-64.png')
}
finally { $mark.Dispose() }

Write-Output 'Building social preview card...'
$ogW = 1200; $ogH = 630
$og = New-Object System.Drawing.Bitmap($ogW, $ogH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($og)
try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $rect = New-Object System.Drawing.Rectangle(0, 0, $ogW, $ogH)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 4, 8, 15),
        [System.Drawing.Color]::FromArgb(255, 10, 74, 122),
        145.0)
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()

    $whiteBanner = [System.Drawing.Image]::FromFile((Join-Path $outDir 'banner-white.png'))
    try {
        $targetW = 820
        $targetH = [int][Math]::Round($whiteBanner.Height * ($targetW / $whiteBanner.Width))
        $g.DrawImage($whiteBanner, [int](($ogW - $targetW) / 2), 210, $targetW, $targetH)
    }
    finally { $whiteBanner.Dispose() }

    $font = New-Object System.Drawing.Font('Segoe UI', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 226, 244, 255))
    $g.DrawString('Music Evaluation Delphi Study', $font, $textBrush, (New-Object System.Drawing.RectangleF(0, 400, $ogW, 60)), $fmt)
    $textBrush.Dispose(); $font.Dispose(); $fmt.Dispose()
}
finally { $g.Dispose() }
Save-Png -Bitmap $og -Path (Join-Path $outDir 'og-card.png')
$og.Dispose()

Write-Output 'Done. Image assets written to assets/img.'
