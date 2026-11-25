# 把指定进程名的前台窗口调到前面（信息中枢弹窗上的"打开"按钮用）
# 输出：ok / not-running / error:<原因>
param([Parameter(Mandatory = $true)][string]$Name)
$ErrorActionPreference = 'Continue'
try {
  $p = Get-Process -Name $Name -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { Write-Output 'not-running'; exit 0 }
  $shell = New-Object -ComObject WScript.Shell
  $ok = $shell.AppActivate($p.Id)
  if ($ok) { Write-Output 'ok' } else { Write-Output 'error:AppActivate 失败' }
} catch {
  Write-Output ('error:' + $_.Exception.Message)
}
