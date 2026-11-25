param([string]$out = "shot.png", [int]$x = 0, [int]$y = 0, [int]$w = 800, [int]$h = 400)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;
public class DP{ [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[void][DP]::SetProcessDPIAware()
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("SHOT $out  region=$x,$y ${w}x${h}")
