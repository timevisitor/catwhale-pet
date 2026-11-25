
Add-Type @'
using System;using System.Runtime.InteropServices;
public class MV5{
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public struct RECT{public int L,T,R,B;}
 delegate bool EnumProc(IntPtr h,IntPtr p);
 public static IntPtr Find(int w,int h){IntPtr found=IntPtr.Zero;EnumWindows((win,p)=>{RECT r;GetWindowRect(win,out r);
  if(r.R-r.L==w && r.B-r.T==h){found=win;return false;} return true;},IntPtr.Zero);return found;}
}
'@
[void][MV5]::SetProcessDPIAware()
$h=[MV5]::Find(960,225)
$r=New-Object MV5+RECT; [void][MV5]::GetWindowRect($h,[ref]$r)
# 胶囊下方的空白带 CSS(320,138)
$px=[int]($r.L + 320*1.5); $py=[int]($r.T + 138*1.5)
[void][MV5]::SetCursorPos($px, $py)
Start-Sleep -Milliseconds 150
for($i=0;$i -lt 10;$i++){ [MV5]::mouse_event(0x0001, 6, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 40 }
Write-Output ("moved to blank $px,$py")
