# 安装 / 卸载 DSH Bridge 静音语音（SAPI 5）。
#   安装：powershell -ExecutionPolicy Bypass -File install-voice.ps1
#   卸载：powershell -ExecutionPolicy Bypass -File install-voice.ps1 -Uninstall
#
# 做的事：
#   1. 用 Windows 自带的 C# 编译器编译 DSHBridgeTts.cs，放到 %LOCALAPPDATA%\DSHBridge\voice\。
#   2. 当前用户登记 COM 类（HKCU，不需要管理员）：游戏（普通权限）从这里加载引擎。
#   3. 弹一次管理员确认（UAC），只在 HKLM 写一张“语音名片”，让游戏能列出这个语音。
#      HKLM 不登记 COM 类，所以以管理员身份运行的程序不会加载这个 DLL。
# 装完要完整重启魔兽。
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$VoiceName = 'DSHBridge'
$Clsid = '{D6C18D54-4DF5-4B50-B4BD-5BF06FEB1F5A}'
$Class = 'DSHBridge.Tts.Engine'
$Assembly = 'DSHBridgeTts, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Reg = Join-Path $env:WINDIR 'System32\reg.exe'
$Source = Join-Path $PSScriptRoot 'DSHBridgeTts.cs'
$OutDir = Join-Path $env:LOCALAPPDATA 'DSHBridge\voice'
$Dll = Join-Path $OutDir 'DSHBridgeTts.dll'
$UserClassKeys = @("HKCU\Software\Classes\CLSID\$Clsid", "HKCU\Software\Classes\WOW6432Node\CLSID\$Clsid")
$UserToken = "HKCU\Software\Microsoft\Speech\Voices\Tokens\$VoiceName"
$MachineToken = "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech\Voices\Tokens\$VoiceName"

function RegAdd([string[]]$a) {
  & $Reg add @a /f | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "reg add 失败: $($a -join ' ')" }
}
# reg.exe writes "key not found" to stderr; Windows PowerShell 5.1 would turn that into a terminating error under Stop.
function RegDel([string]$key) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  & $Reg delete $key /f 2>&1 | Out-Null
  $ErrorActionPreference = $old
}
function RegExists([string]$key) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  & $Reg query $key /reg:64 2>&1 | Out-Null
  $found = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $old
  return $found
}

function Invoke-Elevated([string]$regText) {
  $file = Join-Path $env:TEMP ("dshbridge-voice-" + [Guid]::NewGuid().ToString('N') + '.reg')
  [IO.File]::WriteAllText($file, $regText, [Text.Encoding]::Unicode)
  try {
    Write-Host '请在弹出的“用户账户控制”窗口点“是”（只写入语音名片）……'
    $p = Start-Process -FilePath $Reg -ArgumentList @('import', "`"$file`"", '/reg:64') -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    if ($p.ExitCode -ne 0) { throw "管理员步骤失败（reg import 退出码 $($p.ExitCode)）" }
  } catch [System.InvalidOperationException] {
    throw '已取消管理员确认，语音名片没有写入。'
  } finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

if ($Uninstall) {
  foreach ($k in $UserClassKeys + $UserToken) { RegDel $k }
  if (RegExists ($MachineToken -replace '^HKEY_LOCAL_MACHINE', 'HKLM')) {
    Invoke-Elevated ("Windows Registry Editor Version 5.00`r`n`r`n[-$MachineToken]`r`n")
  }
  if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host '已卸载 DSH Bridge 语音。'
  exit 0
}

# 1. 编译
if (-not (Test-Path -LiteralPath $Csc)) { throw "找不到 C# 编译器：$Csc" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$build = Join-Path $OutDir ('.build-' + [DateTime]::UtcNow.Ticks)
New-Item -ItemType Directory -Force -Path $build | Out-Null
$fresh = Join-Path $build 'DSHBridgeTts.dll'
& $Csc /nologo /target:library /optimize+ "/out:$fresh" $Source
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $build -Recurse -Force; throw '编译失败' }
if (Test-Path -LiteralPath $Dll) {
  # 游戏用过这个语音时会一直占着 DLL：占用中的 DLL 不能删，但能改名。
  try { Remove-Item -LiteralPath $Dll -Force } catch { Rename-Item -LiteralPath $Dll -NewName ('DSHBridgeTts.dll.old-' + [DateTime]::UtcNow.Ticks) }
}
Move-Item -LiteralPath $fresh -Destination $Dll
Remove-Item -LiteralPath $build -Recurse -Force
Get-ChildItem -LiteralPath $OutDir -Filter 'DSHBridgeTts.dll.old-*' | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch { } }
Write-Host "已编译：$Dll"

# 2. 当前用户的 COM 类和语音名片
$codeBase = 'file:///' + ($Dll -replace '\\', '/')
foreach ($key in $UserClassKeys) {
  RegDel $key
  RegAdd @($key, '/ve', '/d', $Class)
  $in = "$key\InprocServer32"
  RegAdd @($in, '/ve', '/d', 'mscoree.dll')
  RegAdd @($in, '/v', 'ThreadingModel', '/d', 'Both')
  RegAdd @($in, '/v', 'Class', '/d', $Class)
  RegAdd @($in, '/v', 'Assembly', '/d', $Assembly)
  RegAdd @($in, '/v', 'RuntimeVersion', '/d', 'v4.0.30319')
  RegAdd @($in, '/v', 'CodeBase', '/d', $codeBase)
}
RegAdd @($UserToken, '/ve', '/d', $VoiceName)
RegAdd @($UserToken, '/v', '409', '/d', $VoiceName)
RegAdd @($UserToken, '/v', 'CLSID', '/d', $Clsid)
$attrs = "$UserToken\Attributes"
foreach ($pair in @(@('Name', $VoiceName), @('Gender', 'Female'), @('Age', 'Adult'), @('Language', '409'), @('Vendor', 'DSH Bridge'))) {
  RegAdd @($attrs, '/v', $pair[0], '/d', $pair[1])
}
Write-Host '已登记当前用户的语音引擎。'

# 3. 系统语音名片（一次 UAC）
$regText = @(
  'Windows Registry Editor Version 5.00', '',
  "[$MachineToken]", "@=`"$VoiceName`"", "`"409`"=`"$VoiceName`"", "`"CLSID`"=`"$Clsid`"", '',
  "[$MachineToken\Attributes]", "`"Name`"=`"$VoiceName`"", '"Gender"="Female"', '"Age"="Adult"', '"Language"="409"', '"Vendor"="DSH Bridge"', ''
) -join "`r`n"
Invoke-Elevated $regText

if (-not (RegExists ($MachineToken -replace '^HKEY_LOCAL_MACHINE', 'HKLM'))) { throw '语音名片没有写进 HKLM。' }
Write-Host '完成：DSHBridge 语音已安装。请完整重启魔兽（退出再开），然后启动桥接（node bridge\bridge.mjs run），在游戏里输入 /dshc test。'
