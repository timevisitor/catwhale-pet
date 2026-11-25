param([string]$out = "shot.png", [int]$padL = 120, [int]$padT = 60, [int]$padR = 120, [int]$padB = 260)
Add-Type @'
using System;using System.Runtime.InteropServices;
public class CAP{
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public struct RECT{public int L,T,R,B;}
 delegate bool EnumProc(IntPtr h,IntPtr p);
 public static IntPtr Find(int w,int h){IntPtr found=IntPtr.Zero;EnumWindows((win,p)=>{RECT r;GetWindowRect(win,out r);
  if(r.R-r.L==w && r.B-r.T==h){found=win;return false;} return true;},IntPtr.Zero);return found;}
}
'@
[void][CAP]::SetProcessDPIAware()
$h = [CAP]::Find(960,225)
if($h -eq [IntPtr]::Zero){ Write-Output "NO-ISLAND(960x225)"; exit 1 }
$r = New-Object CAP+RECT
[void][CAP]::GetWindowRect($h, [ref]$r)
$x = [Math]::Max(0, $r.L - $padL); $y = [Math]::Max(0, $r.T - $padT)
$w = ($r.R + $padR) - $x; $hh = ($r.B + $padB) - $y
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("SHOT $out  region=$x,$y ${w}x${hh}")
