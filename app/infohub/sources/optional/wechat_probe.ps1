<#
  wechat_probe.ps1 —— 读 Windows「通知中心」里微信条目的探针（被 wechat.js 调用，也可单独跑）
  --------------------------------------------------------------------------
  两条引擎：
    winrt : UserNotificationListener（Windows 官方读取通知中心的 API，Win10/11 通用）
            优点：不需要把面板打开，直接拿应用名 + 标题 + 正文 + 时间
    uia   : UIAutomationClient 扫通知中心面板（面板打开时才有节点；XamlIsland 有时不暴露）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File wechat_probe.ps1 -OutFile out.json
    powershell ... -File wechat_probe.ps1 -Engine uia            # 只走 UIA
    powershell ... -File wechat_probe.ps1 -RequestAccess         # 弹系统授权框（仅首次需要）

  输出（JSON，UTF-8）：
    { ok, engine, access, panelFound, count, wechatCount, items:[{app,aumid,id,title,body,creation}], error }
#>
param(
  [string]$OutFile = '',
  [ValidateSet('auto', 'winrt', 'uia')][string]$Engine = 'auto',
  [switch]$RequestAccess,
  [int]$MaxItems = 40
)

$ErrorActionPreference = 'Continue'
$result = [ordered]@{
  ok          = $false
  engine      = $Engine
  access      = 'unknown'
  panelFound  = $false
  count       = 0
  wechatCount = 0
  items       = @()
  error       = ''
}

function Join-TextBlock($texts) {
  $clean = @()
  foreach ($t in $texts) {
    if ($null -eq $t) { continue }
    $s = ([string]$t) -replace '\s+', ' '
    $s = $s.Trim()
    if ($s) { $clean += $s }
  }
  return $clean
}

# ---------------- 引擎 1：WinRT UserNotificationListener ----------------
function Invoke-WinRT {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  [void][Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = $listener.GetAccessStatus().ToString()
  $script:result.access = $access

  if ($access -ne 'Allowed') {
    if ($RequestAccess) {
      $opA = $listener.RequestAccessAsync()
      $tA = $asTask.MakeGenericMethod([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]).Invoke($null, @($opA))
      if ($tA.Wait(15000)) {
        $access = $tA.Result.ToString()
        $script:result.access = $access
      }
    }
    if ($access -ne 'Allowed') {
      $script:result.error = "系统未允许读取通知（$access）。到 设置 → 系统 → 通知 → 允许通知访问（或本机「通知助手」开关）打开后重试。"
      return
    }
  }

  $op = $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
  $task = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]).Invoke($null, @($op))
  if (-not $task.Wait(10000)) {
    $script:result.error = 'GetNotificationsAsync 超时'
    return
  }

  $items = @()
  foreach ($n in $task.Result) {
    $app = ''; $aumid = ''; $title = ''; $body = ''; $creation = ''
    try { $app = [string]$n.AppInfo.DisplayInfo.DisplayName } catch { $app = '' }
    try { $aumid = [string]$n.AppInfo.AppUserModelId } catch { $aumid = '' }
    try {
      $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      $texts = Join-TextBlock @($binding.GetTextElements() | ForEach-Object { $_.Text })
      if ($texts.Count -gt 0) { $title = $texts[0] }
      if ($texts.Count -gt 1) { $body = ($texts[1..($texts.Count - 1)] -join ' / ') }
    } catch {
      try {
        $binding2 = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::Toast)
        $texts2 = Join-TextBlock @($binding2.GetTextElements() | ForEach-Object { $_.Text })
        if ($texts2.Count -gt 0) { $title = $texts2[0] }
        if ($texts2.Count -gt 1) { $body = ($texts2[1..($texts2.Count - 1)] -join ' / ') }
      } catch { }
    }
    try { $creation = $n.CreationTime.ToString('o') } catch { $creation = '' }
    $items += [pscustomobject]@{
      app      = $app
      aumid    = $aumid
      id       = [string]$n.Id
      title    = $title
      body     = $body
      creation = $creation
    }
  }
  $script:result.items = @($items | Select-Object -First $MaxItems)
  $script:result.count = $items.Count
  $script:result.ok = $true
}

# ---------------- 引擎 2：UIAutomationClient 扫面板 ----------------
function Invoke-UIA {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)

  $panel = $null
  foreach ($w in $wins) {
    $cn = ''; $nm = ''
    try { $cn = [string]$w.Current.ClassName } catch { }
    try { $nm = [string]$w.Current.Name } catch { }
    if ($cn -like '*XamlExplorerHost*' -or $cn -eq 'Windows.UI.Core.CoreWindow' -or $nm -match '通知中心|Notification Center|Notifications') {
      $panel = $w
      break
    }
  }
  if (-not $panel) {
    $script:result.error = '通知中心面板没打开（Win+N 打开后重试），或本系统把面板做成 XamlIsland 不暴露给 UIA'
    return
  }
  $script:result.panelFound = $true
  $script:result.engine = 'uia'

  $all = $panel.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $items = @()
  foreach ($e in $all) {
    $name = ''
    try { $name = [string]$e.Current.Name } catch { }
    $ct = ''
    try { $ct = [string]$e.Current.ControlType.ProgrammaticName } catch { }
    if (-not $name) { continue }
    if ($name -match '微信|WeChat|Weixin') {
      $items += [pscustomobject]@{
        app      = '微信（面板文本）'
        aumid    = ''
        id       = [string]$e.GetHashCode()
        title    = $name
        body     = ''
        creation = ''
      }
    }
  }
  $script:result.count = $items.Count
  $script:result.items = @($items | Select-Object -First $MaxItems)
  $script:result.ok = $true
  if ($items.Count -eq 0) { $script:result.error = '面板里没有找到含「微信/WeChat」的文本节点' }
}

# ---------------- 主流程 ----------------
$engines = @()
if ($Engine -eq 'auto') { $engines = @('winrt', 'uia') } else { $engines = @($Engine) }

foreach ($e in $engines) {
  $script:result.engine = $e
  try {
    if ($e -eq 'winrt') { Invoke-WinRT } else { Invoke-UIA }
  } catch {
    $script:result.error = "$e 引擎异常：" + $_.Exception.Message
    $script:result.ok = $false
  }
  if ($script:result.ok) { break }
}

# 统计微信条目（应用名或 AUMID 命中）
$wx = @($result.items | Where-Object { ($_.app + ' ' + $_.aumid) -match '微信|WeChat|Weixin' })
$result.wechatCount = $wx.Count

$json = $result | ConvertTo-Json -Depth 6 -Compress
if ($OutFile) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $json, $utf8)
} else {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $json
}
