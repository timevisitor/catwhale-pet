# Catwhale pet - combined local media probe (SMTC metadata + WASAPI who-is-audible)
# One compact JSON per line. ASCII ONLY (PS 5.1 mis-decodes non-BOM UTF-8).
#
# Why both layers:
#   SMTC  = the only source of title/artist/genres/playback-type, but many Chinese
#           music apps (NetEase CloudMusic, measured) never register a session.
#   WASAPI= who is actually pushing samples to the default render endpoint; catches
#           the apps SMTC misses, and catches "SMTC says Playing but silent".
#   usage: powershell -NoProfile -ExecutionPolicy Bypass -File media_probe.ps1 [-Once] [-IntervalMs 1000]
param([switch]$Once, [int]$IntervalMs = 1000)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop } catch { }

if (-not ('PetAudio.Probe' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'WasapiProbe.cs') -ErrorAction Stop
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  if ($null -eq $op) { return $null }
  try {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    return $task.Result
  } catch { return $null }
}
$SMTC_TYPE = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$MEDIA_PROPS = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

function GetSmtc {
  $list = @()
  try {
    $mgr = Await ($SMTC_TYPE::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if ($null -eq $mgr) { return $list }
    foreach ($s in $mgr.GetSessions()) {
      $item = @{ app = ''; status = ''; pbType = '' }
      try { $item.app = [string]$s.SourceAppUserModelId } catch { }
      try {
        $pi = $s.GetPlaybackInfo()
        $item.status = [string]$pi.PlaybackStatus
        $item.pbType = [string]$pi.PlaybackType
      } catch { }
      try {
        $p = Await ($s.TryGetMediaPropertiesAsync()) $MEDIA_PROPS
        if ($p) {
          $item.title = [string]$p.Title
          $item.artist = [string]$p.Artist
          $item.album = [string]$p.AlbumTitle
          $item.pbTypeProps = [string]$p.PlaybackType
          $gs = @(); foreach ($g in $p.Genres) { $gs += [string]$g }
          $item.genres = $gs
        }
      } catch { }
      try {
        $tl = $s.GetTimelineProperties()
        if ($tl) { $item.pos = [math]::Round($tl.Position.TotalSeconds, 2); $item.end = [math]::Round($tl.EndTime.TotalSeconds, 2) }
      } catch { }
      $list += $item
    }
  } catch { }
  return $list
}

function GetWasapi {
  $list = @()
  try {
    foreach ($s in [PetAudio.Probe]::Sessions()) {
      if ($s.pid -eq 0) { continue }                       # System Sounds
      if ($s.proc -eq 'NVIDIA Broadcast') { continue }
      if ($s.state -ne 'Active' -and $s.peak -le 0.0001) { continue }
      $item = @{ pid = $s.pid; proc = $s.proc; state = $s.state; peak = [math]::Round($s.peak, 4) }
      $item.win = GetWinTitle $s.pid
      $list += $item
    }
  } catch { }
  return $list
}

# Main window title of a process. This is the decisive signal: when Edge plays a
# Bilibili video, SMTC reports PlaybackType=Music with an empty artist, so only the
# site name in the window title (bilibili/youtube/...) tells video from song.
#
# IMPORTANT (measured): the PID that owns the audio session is NOT the PID that owns
# the window. Chromium/Edge are multi-process: audio comes from a renderer/utility
# child, while the tab title lives on the browser process. Get-Process -Id <audio pid>
# .MainWindowTitle therefore returns '' for exactly the case we need it. So we map the
# audio PID up to its process family (same base process name + same parent/executable)
# and take the first visible top-level window title found there.
function GetWinTitle($procId) {
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $nm = $p.ProcessName
    # 1) owns a title itself (single-process apps: cloudmusic, PotPlayer, ...)
    if ($p.MainWindowTitle) { return [string]$p.MainWindowTitle }
    # 2) multi-process browsers: look for a titled window in the same process family
    $siblings = @(Get-Process -Name $nm -ErrorAction SilentlyContinue)
    if ($siblings.Count -le 1) { return '' }
    $titles = @()
    foreach ($s in $siblings) {
      if ($s.Id -eq $procId) { continue }
      if ($s.MainWindowTitle) { $titles += [string]$s.MainWindowTitle }
    }
    if ($titles.Count -eq 0) { return '' }
    # prefer a title that names a media site (several tabs/windows may be open)
    foreach ($t in $titles) {
      if ($t -match 'bilibili|youtube|youku|iqiyi|v\.qq\.com|mgtv|netflix|twitch|spotify') { return $t }
    }
    return $titles[0]
  } catch { }
  return ''
}

function Emit {
  $o = @{ ok = $true; ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); smtc = @(); wasapi = @() }
  try { $o.smtc = @(GetSmtc) } catch { $o.ok = $false; $o.errSmtc = $_.Exception.Message }
  try { $o.wasapi = @(GetWasapi) } catch { $o.ok = $false; $o.errWasapi = $_.Exception.Message }
  [Console]::Out.WriteLine((ConvertTo-Json $o -Depth 6 -Compress))
  [Console]::Out.Flush()
}

if ($Once) { Emit; exit 0 }
while ($true) { Emit; Start-Sleep -Milliseconds $IntervalMs }
