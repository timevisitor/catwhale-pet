
Add-Type @'
using System;using System.Runtime.InteropServices;
public class RD{
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int idx);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 public struct RECT{public int L,T,R,B;}
 delegate bool EnumProc(IntPtr h,IntPtr p);
 public static IntPtr Find(int w,int h){IntPtr found=IntPtr.Zero;EnumWindows((win,p)=>{RECT r;GetWindowRect(win,out r);
  if(r.R-r.L==w && r.B-r.T==h){found=win;return false;} return true;},IntPtr.Zero);return found;}
 public static string Ex(IntPtr h){long e=(long)GetWindowLongPtr(h,-20);
  return "WS_EX_TRANSPARENT="+(((e&0x20)!=0)?"YES":"no");}
}
'@
[void][RD]::SetProcessDPIAware()
$h=[RD]::Find(960,225)
if($h -eq [IntPtr]::Zero){ Write-Output "NO-ISLAND"; exit 1 }
Write-Output ([RD]::Ex($h))
