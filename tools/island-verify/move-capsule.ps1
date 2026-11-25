
Add-Type @'
using System;using System.Runtime.InteropServices;
public class MV4{
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
[void][MV4]::SetProcessDPIAware()
$h=[MV4]::Find(960,225)
$r=New-Object MV4+RECT; [void][MV4]::GetWindowRect($h,[ref]$r)
# CSS 坐标 (405,110) → 物理 = 窗口左上 + css*1.5
$px=[int]($r.L + 405*1.5); $py=[int]($r.T + 110*1.5)
[void][MV4]::SetCursorPos($px-40,$py)
Start-Sleep -Milliseconds 150
for($i=0;$i -lt 10;$i++){ [MV4]::mouse_event(0x0001, 8, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 40 }
Write-Output ("moved to capsule area $px,$py")
