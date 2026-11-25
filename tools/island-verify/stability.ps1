param([int]$n = 24, [int]$gapMs = 400)
Add-Type @'
using System;using System.Runtime.InteropServices;
public class SB{
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public struct RECT{public int L,T,R,B;}
 delegate bool EnumProc(IntPtr h,IntPtr p);
 public static IntPtr Find(int w,int h){IntPtr found=IntPtr.Zero;EnumWindows((win,p)=>{RECT r;GetWindowRect(win,out r);
  if(r.R-r.L==w && r.B-r.T==h){found=win;return false;} return true;},IntPtr.Zero);return found;}
 public static string P(IntPtr h){RECT r;GetWindowRect(h,out r);return r.L+","+r.T;}
}
'@
[void][SB]::SetProcessDPIAware()
$h = [SB]::Find(960,225)
if($h -eq [IntPtr]::Zero){ Write-Output "NO-ISLAND"; exit 1 }
$seen = @{}
for($i=0; $i -lt $n; $i++){
  $p = [SB]::P($h)
  if($seen.ContainsKey($p)){ $seen[$p]++ } else { $seen[$p] = 1 }
  Start-Sleep -Milliseconds $gapMs
}
Write-Output ("采样 $n 次，出现过 " + $seen.Count + " 个位置")
$seen.GetEnumerator() | Sort-Object -Property Value -Descending | ForEach-Object { Write-Output ("  " + $_.Key + "  x" + $_.Value) }
