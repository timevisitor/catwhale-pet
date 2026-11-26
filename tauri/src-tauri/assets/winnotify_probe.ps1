<#
  winnotify_probe.ps1 —— 读 Windows「通知中心」全部 toast 的探针（winnotify.js 调用，可单独跑）
  ------------------------------------------------------------------------------------------
  与 wechat_probe.ps1 的区别（本文件是泛化版，老文件保持不动作参考）：
    1. 不按「微信」过滤，返回通知中心里的**全部**条目，应用归属交给 JS 判定；
    2. 额外返回原始文本数组 texts[]（而不是合并好的 title/body），因为不同应用的
       toast 文本结构不一样，必须让 JS 按应用各自解析：
         · 微信 4.x：texts[0]=应用名（微信）、texts[1]=会话名、texts[2]="发送者 : 正文"
           （来源：PepsiColaya/wechat-notifier README）
         · QQ / 飞书 / 钉钉 / 企业微信：texts[0]=第一行（会话名）、其余是正文
    3. 同时仍返回 title/body 两个派生字段，方便人肉看/兼容旧逻辑。

  两条引擎（沿用 wechat_probe.ps1 的实测结论）：
    winrt : UserNotificationListener（Windows 官方 API，Win10/11 通用，本机 access=Allowed）
    uia   : UIAutomationClient 扫通知中心面板（面板打开才有节点；本机 Win11 面板不是 UIA 顶层子窗口，扫不到，
            仅作兜底，且只能拿到文本节点、拿不到应用归属）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File winnotify_probe.ps1 -OutFile out.json
    powershell ... -File winnotify_probe.ps1 -Engine uia
    powershell ... -File winnotify_probe.ps1 -RequestAccess     # 系统没授权时弹一次授权框

  输出（JSON，UTF-8 写盘）：
    { ok, engine, access, panelFound, count, error,
      items:[{app,aumid,id,creation,texts:[...],title,body}] }
#>
param(
  [string]$OutFile = '',
  [ValidateSet('auto', 'winrt', 'uia')][string]$Engine = 'auto',
  [switch]$RequestAccess,
  [int]$MaxItems = 60
)

$ErrorActionPreference = 'Continue'
$result = [ordered]@{
  ok         = $false
  engine     = $Engine
  access     = 'unknown'
  panelFound = $false
  count      = 0
  items      = @()
  error      = ''
}

# 把一串文本元素清洗成非空数组（折叠空白、去空串），保留原始顺序 —— 顺序就是解析依据
function Clean-Texts($texts) {
  $out = @()
  foreach ($t in $texts) {
    if ($null -eq $t) { continue }
    $s = ([string]$t) -replace '\s+', ' '
    $s = $s.Trim()
    if ($s) { $out += $s }
  }
  return $out
}

# 从 toast 绑定里取文本数组：先 ToastGeneric，取不到再退老式 Toast 绑定
function Get-ToastTexts($notification) {
  $texts = @()
  try {
    $binding = $notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
    $texts = Clean-Texts @($binding.GetTextElements() | ForEach-Object { $_.Text })
  } catch { $texts = @() }
  if ($texts.Count -eq 0) {
    try {
      $binding2 = $notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::Toast)
      $texts = Clean-Texts @($binding2.GetTextElements() | ForEach-Object { $_.Text })
    } catch { $texts = @() }
  }
  return $texts
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
    $app = ''; $aumid = ''; $creation = ''
    try { $app = [string]$n.AppInfo.DisplayInfo.DisplayName } catch { $app = '' }
    try { $aumid = [string]$n.AppInfo.AppUserModelId } catch { $aumid = '' }
    try { $creation = $n.CreationTime.ToString('o') } catch { $creation = '' }

    $texts = Get-ToastTexts $n.Notification
    $title = ''
    $body = ''
    if ($texts.Count -gt 0) { $title = $texts[0] }
    if ($texts.Count -gt 1) { $body = ($texts[1..($texts.Count - 1)] -join ' / ') }

    $items += [pscustomobject]@{
      app      = $app
      aumid    = $aumid
      id       = [string]$n.Id
      creation = $creation
      texts    = @($texts)
      title    = $title
      body     = $body
    }
  }
  $script:result.items = @($items | Select-Object -First $MaxItems)
  $script:result.count = $items.Count
  $script:result.ok = $true
}

# ---------------- 引擎 2：UIAutomationClient 扫面板（兜底，拿不到应用归属） ----------------
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
  $i = 0
  foreach ($e in $all) {
    $name = ''
    try { $name = [string]$e.Current.Name } catch { }
    $name = ($name -replace '\s+', ' ').Trim()
    if (-not $name) { continue }
    $i++
    # UIA 拿不到「这条文本属于哪个应用」，只能把每个文本节点当成一条，应用名写死为面板
    $items += [pscustomobject]@{
      app      = '通知中心面板'
      aumid    = ''
      id       = [string]$i
      creation = ''
      texts    = @($name)
      title    = $name
      body     = ''
    }
  }
  $script:result.count = $items.Count
  $script:result.items = @($items | Select-Object -First $MaxItems)
  $script:result.ok = $true
  if ($items.Count -eq 0) { $script:result.error = '面板里没有找到文本节点' }
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

$json = $result | ConvertTo-Json -Depth 6 -Compress
if ($OutFile) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $json, $utf8)
} else {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $json
}
