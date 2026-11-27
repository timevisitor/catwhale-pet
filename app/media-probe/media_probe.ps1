# Catwhale pet - combined local media probe (SMTC metadata + WASAPI who-is-audible)
# One compact JSON per line. ASCII ONLY (PS 5.1 mis-decodes non-BOM UTF-8).
#
# Why both layers:
#   SMTC  = the only source of title/artist/genres/playback-type, but many Chinese
#           music apps (NetEase CloudMusic, measured) never register a session.
#   WASAPI= who is actually pushing samples to the default render endpoint; catches
#           the apps SMTC misses, and catches "SMTC says Playing but silent".
#   usage: powershell -NoProfile -ExecutionPolicy Bypass -File media_probe.ps1 [-Once] [-IntervalMs 1000] [-SlowMs 2500]
#
# Cadence (v0.7.2 optimization):
#   -IntervalMs is the FAST cadence used while something is audible (waveform / lyrics
#   need it). -SlowMs > 0 enables the idle cadence: after IDLE_ROUNDS consecutive quiet
#   samples the loop falls back to -SlowMs and returns to fast on the first loud sample.
#   Measured on the dev box: fixed 600ms = 2.6% of one core all day; adaptive = fast only
#   while media actually plays, ~0.5% the rest of the time. -SlowMs 0 keeps the old
#   fixed-interval behaviour.
param([switch]$Once, [int]$IntervalMs = 1000, [int]$SlowMs = 0)
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

# Same floor as media-detect.js PEAK_MIN: below this the stream is silence / noise.
$PEAK_MIN = 0.004
# Quiet samples in a row before dropping to the slow cadence (6 x 600ms = 3.6s:
# covers track gaps and WASAPI's 0.3~0.8s meter tail without flapping).
$IDLE_ROUNDS = 6
# Window titles change far slower than the audio meter; re-query at most this often.
$TITLE_TTL_MS = 5000

function GetSmtc {
  $list = @()
  $mgr = $null
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
  finally {
    # WinRT objects are RCWs; without an explicit release they sit until a GC runs,
    # which for a long-lived loop means the session manager piles up sample by sample.
    if ($null -ne $mgr) { try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($mgr) } catch { } }
  }
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
# IMPORTANT (measured): the PID that owns the audio session is NOT the PID that owns the
# window. Chromium/Edge are multi-process: audio comes from a renderer/utility
# child, while the tab title lives on the browser process. Get-Process -Id <audio pid>
# .MainWindowTitle therefore returns '' for exactly the case we need it. So we map the
# audio PID up to its process family (same base process name + same parent/executable)
# and take the first visible top-level window title found there.
#
# COST (measured): Get-Process -Name <browser> enumerates every process on the box and
# was the single most expensive step of a sample (~1/3 of the probe's CPU at 600ms).
# Titles only change on tab/video switches, so both lookups are memoized for
# $TITLE_TTL_MS; a stale title for <=5s is invisible next to the 1.2s start debounce.
$titleCache = @{}
function GetWinTitle($procId) {
  $now = [Environment]::TickCount
  $k = [string]$procId
  $c = $titleCache[$k]
  if ($null -ne $c -and ($now - $c.at) -lt $TITLE_TTL_MS) { return $c.t }
  if ($titleCache.Count -gt 256) { $titleCache.Clear() }   # browsers recycle PIDs all day
  $title = ''
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    $nm = $p.ProcessName
    # 1) owns a title itself (single-process apps: cloudmusic, PotPlayer, ...)
    if ($p.MainWindowTitle) { $title = [string]$p.MainWindowTitle }
    else {
      # 2) multi-process browsers: look for a titled window in the same process family
      $fk = 'f:' + $nm
      $fam = $titleCache[$fk]
      if ($null -ne $fam) { $title = $fam.t }
      else {
        $siblings = @(Get-Process -Name $nm -ErrorAction SilentlyContinue)
        if ($siblings.Count -le 1) { $title = '' }
        else {
          $titles = @()
          foreach ($s in $siblings) {
            if ($s.Id -eq $procId) { continue }
            if ($s.MainWindowTitle) { $titles += [string]$s.MainWindowTitle }
          }
          if ($titles.Count -eq 0) { $title = '' }
          else {
            # prefer a title that names a media site (several tabs/windows may be open)
            $title = $titles[0]
            foreach ($t in $titles) {
              if ($t -match 'bilibili|youtube|youku|iqiyi|v\.qq\.com|mgtv|netflix|twitch|spotify') { $title = $t; break }
            }
          }
        }
        $titleCache[$fk] = @{ t = $title; at = $now }
      }
    }
  } catch { }
  $titleCache[$k] = @{ t = $title; at = $now }
  return $title
}

function Emit {
  $o = @{ ok = $true; ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); smtc = @(); wasapi = @() }
  try { $o.smtc = @(GetSmtc) } catch { $o.ok = $false; $o.errSmtc = $_.Exception.Message }
  try { $o.wasapi = @(GetWasapi) } catch { $o.ok = $false; $o.errWasapi = $_.Exception.Message }
  [Console]::Out.WriteLine((ConvertTo-Json $o -Depth 6 -Compress))
  [Console]::Out.Flush()
  return $o
}

function Test-Loud($o) {
  foreach ($w in $o.wasapi) { if ([double]$w.peak -ge $PEAK_MIN) { return $true } }
  return $false
}

if ($Once) { [void](Emit); exit 0 }
$idleRounds = 0
$iv = $IntervalMs
while ($true) {
  $o = Emit
  if ($SlowMs -gt 0) {
    if (Test-Loud $o) { $idleRounds = 0 } else { $idleRounds++ }
    if ($idleRounds -ge $IDLE_ROUNDS) { $iv = $SlowMs } else { $iv = $IntervalMs }
  }
  Start-Sleep -Milliseconds $iv
}
