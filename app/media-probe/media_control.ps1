# Catwhale pet - SMTC playback control (information hub)
# One-shot action, prints ok / fail:<reason>. ASCII only (PS 5.1 mangles UTF-8 without BOM).
#
# Why SMTC: it is the same session the probe already reads for metadata, so
# play/pause/next/seek hit exactly the player the user is looking at.
# Volume is NOT part of SMTC - we fall back to the system media keys.
param(
  [Parameter(Mandatory = $true)][ValidateSet('play_pause', 'next', 'prev', 'stop', 'seek', 'vol_up', 'vol_down', 'mute')][string]$Action,
  [int]$Seconds = 0
)
$ErrorActionPreference = 'Continue'
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop } catch { }

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

if ($Action -in @('vol_up', 'vol_down', 'mute')) {
  if (-not ('PetKeys.Send' -as [type])) {
    Add-Type -Namespace PetKeys -Name Send -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
  }
  $code = switch ($Action) { 'vol_up' { 0xAF } 'vol_down' { 0xAE } 'mute' { 0xAD } }
  [PetKeys.Send]::keybd_event([byte]$code, 0, 0, [UIntPtr]::Zero)
  [PetKeys.Send]::keybd_event([byte]$code, 0, 2, [UIntPtr]::Zero)
  Write-Output 'ok'
  exit 0
}

$SMTC_MGR = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$MEDIA_PROPS = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

$mgr = Await ($SMTC_MGR::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
if ($null -eq $mgr) { Write-Output 'fail:no-session-manager'; exit 0 }

# 选会话：优先正在播放的，其次第一个有标题的
$target = $null
$fallback = $null
foreach ($s in $mgr.GetSessions()) {
  $playing = $false
  try { $playing = ([string]$s.GetPlaybackInfo().PlaybackStatus) -eq 'Playing' } catch { }
  $hasTitle = $false
  try { $p = Await ($s.TryGetMediaPropertiesAsync()) $MEDIA_PROPS; if ($p -and $p.Title) { $hasTitle = $true } } catch { }
  if ($playing -and $hasTitle) { $target = $s; break }
  if (-not $fallback -and $hasTitle) { $fallback = $s }
}
if ($null -eq $target) { $target = $fallback }
if ($null -eq $target) { Write-Output 'fail:no-session'; exit 0 }

try {
  switch ($Action) {
    'play_pause' {
      $ok = Await ($target.TryTogglePlayPauseAsync()) ([bool])
      if ($ok) { Write-Output 'ok' } else { Write-Output 'fail:toggle-rejected' }
    }
    'next' {
      $ok = Await ($target.TrySkipNextAsync()) ([bool])
      if ($ok) { Write-Output 'ok' } else { Write-Output 'fail:skip-rejected' }
    }
    'prev' {
      $ok = Await ($target.TrySkipPreviousAsync()) ([bool])
      if ($ok) { Write-Output 'ok' } else { Write-Output 'fail:skip-rejected' }
    }
    'stop' {
      $ok = Await ($target.TryStopAsync()) ([bool])
      if ($ok) { Write-Output 'ok' } else { Write-Output 'fail:stop-rejected' }
    }
    'seek' {
      $ticks = [int64]($Seconds * 10000000)
      $ok = Await ($target.TryChangePlaybackPositionAsync($ticks)) ([bool])
      if ($ok) { Write-Output 'ok' } else { Write-Output 'fail:seek-rejected' }
    }
  }
} catch {
  Write-Output ('fail:' + $_.Exception.Message)
}
