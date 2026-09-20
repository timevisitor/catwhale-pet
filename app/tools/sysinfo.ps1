# 桌宠实时硬件采样（常驻，每 2 秒一行 JSON 到 stdout）
# 为什么这么绕：
#  · Windows 上 os.cpus().speed / WMI CurrentClockSpeed 都只给**标称基频**，恒定不变
#    → 实时频率只能用 '\Processor Information(_Total)\% Processor Performance' × 基频
#  · GPU 频率/占用用 nvidia-smi（本机 RTX 5090，无需管理员）
#  · 内存频率 Win32_PhysicalMemory.Speed 只需读一次
# 注意：本文件必须是 UTF-8 BOM + CRLF（否则中文注释会把行尾换行吞掉，参数解析出错）
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::UTF8

$cpuBase = (Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed
$ramSpeed = (Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Speed -Maximum).Maximum
$hasNv = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)

while ($true) {
  $perf = $null
  try {
    $perf = (Get-Counter '\Processor Information(_Total)\% Processor Performance' -SampleInterval 1 -MaxSamples 1).CounterSamples[0].CookedValue
  } catch { $perf = $null }

  $gpu = $null
  if ($hasNv) {
    $line = (& nvidia-smi --query-gpu=utilization.gpu,clocks.sm,clocks.mem,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>$null) -join ','
    if ($line -and $line -notmatch 'failed') {
      $p = $line -split ','
      $gpu = [ordered]@{ util = [double]$p[0]; clockMHz = [double]$p[1]; memClockMHz = [double]$p[2];
                         memUsedMB = [double]$p[3]; memTotalMB = [double]$p[4]; tempC = [double]$p[5] }
    }
  }

  $freq = $null
  if ($perf) { $freq = [int]($cpuBase * $perf / 100) }

  $o = [ordered]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
                   cpuBaseMHz = $cpuBase; cpuFreqMHz = $freq; ramSpeedMHz = $ramSpeed; gpu = $gpu }
  $o | ConvertTo-Json -Compress -Depth 4
  Start-Sleep -Seconds 2
}
