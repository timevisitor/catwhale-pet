Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;
public class EB{
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public struct RECT{public int L,T,R,B;}
 delegate bool EnumProc(IntPtr h,IntPtr p);
 public static string List(uint[] pids){
   var sb=new StringBuilder();
   EnumWindows((h,p)=>{uint q;GetWindowThreadProcessId(h,out q);
     foreach(var pid in pids){ if(q==pid){RECT r;GetWindowRect(h,out r);
       StringBuilder t=new StringBuilder(128);GetWindowTextW(h,t,128);
       int w=r.R-r.L,hh=r.B-r.T;
       if(w>0&&hh>0) sb.AppendLine(string.Format("{0}x{1} @{2},{3} vis={4} pid={5} title={6}",w,hh,r.L,r.T,IsWindowVisible(h),q,t.ToString()));
       break;}}
     return true;},IntPtr.Zero);
   return sb.ToString();
 }
}
'@
$pids = @(Get-Process electron -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Write-Output ("electron 进程: " + ($pids -join ','))
Write-Output ([EB]::List([uint32[]]$pids))
