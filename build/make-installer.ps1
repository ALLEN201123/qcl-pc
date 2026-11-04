# Quanta Craft Launcher PC · 生成中文安装程序（.NET 自解压方案）
#
# ============================================================================
# 为什么是这套方案（前面的方案都试过，只有这个稳）：
#
#   ① NSIS（electron-builder 自带）—— 失败
#      makensis 是 32 位程序，必须把待压缩数据整块 mmap 进内存：
#      `error creating mmap the size of 214871488`
#      本机可用内存 0.3~0.8 GB（DSH 自己就占 2.3GB），这条路走不通。
#
#   ② 7-Zip SFX（7z.sfx）—— 不合格
#      · 标准 7-Zip 的 sfx **不读取** Title / BeginPrompt / InstallPath / GUIMode 这些键
#        （只有第三方 7zSFX 修改版才支持）⇒ 界面永远是英文，配置白写。
#        这就是为什么两个包看起来「一模一样全是英文」。
#      · 它还要求机器上装了 7-Zip 才能跑 —— 目标用户很可能没有。
#
#   ③ .NET Framework 内置编译器（本脚本用的）—— 可用
#      Windows 自带 csc.exe，编译出一个**原生 exe**：
#        · 自己解压 zip（System.IO.Compression 是 Windows 内置的）
#        · 界面自己画（Windows Forms），全部简体中文
#        · 不需要目标机器装任何东西（.NET Framework 4.x 是 Win10/11 自带的）
# ============================================================================

param(
  [switch]$SkipPack,
  [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dist = Join-Path $root 'dist'
$unpacked = Join-Path $dist 'win-unpacked'
$buildDir = Join-Path $root 'build\installer\_work'
$zipPath = Join-Path $buildDir 'payload.zip'
$outExe = Join-Path $dist "QCL-安装程序-$Version.exe"
$csFile = Join-Path $root 'build\installer\Installer.cs'
$iconFile = Join-Path $root 'build\icon.ico'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. 打包目录版
if (-not $SkipPack) {
  Step '1/4 electron-builder --dir（产出 win-unpacked）'
  Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
  & npx electron-builder --config electron-builder.config.js --win --x64 --dir
  if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir 失败（exit=$LASTEXITCODE）" }
}

$qclExe = Join-Path $unpacked 'QCL.exe'
if (-not (Test-Path $qclExe)) { throw "没有 $qclExe，先跑 npm run pack" }
Write-Host ("win-unpacked: {0:N1} MB" -f ((Get-ChildItem $unpacked -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))

# ---------------------------------------------------------------- 2. 打成 zip
Step '2/4 把 win-unpacked 打成 zip（zip 内部直接是 QCL.exe 等文件，没有多余层级）'
Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$sw = [Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $unpacked,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false   # ★ false = 不把源目录名当成 zip 里的顶层目录
)
$zipMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ("payload.zip: {0} MB，用时 {1:N1}s" -f $zipMB, $sw.Elapsed.TotalSeconds)

# 校验 zip 顶层
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $names = @($zip.Entries | Select-Object -First 60 | ForEach-Object { $_.FullName })
} finally {
  $zip.Dispose()
}
if ($names -notcontains 'QCL.exe') {
  Write-Host 'zip 前 10 项：'
  $names | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
  throw 'zip 顶层没有 QCL.exe，打包结构不对'
}
Write-Host '✅ zip 顶层结构正确（直接就是 QCL.exe / resources / locales …）'

# ---------------------------------------------------------------- 3. 编译安装程序
Step '3/4 用系统自带 csc.exe 编译中文安装程序'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw '找不到 .NET Framework 自带的 csc.exe' }
Write-Host "编译器: $csc"

$fwDir = Split-Path $csc -Parent
$refs = @()
foreach ($asm in @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll')) {
  # ★ 2026-11-05 修：以前用 `Split-Path (Split-Path $csc) -Parent`，
  #   算出的是 C:\Windows\Microsoft.NET\Framework64（少了 v4.0.30319 这一层），
  #   于是所有 /r: 引用都找不到文件，csc 报 CS0246 ZipArchive。
  #   ⇒ 改为 `Split-Path $csc -Parent`（= ...\Framework64\v4.0.30319），
  #     再在 Framework64 → Framework 兜底找一遍，两边都试。
  $candidates = @(
    (Join-Path $fwDir $asm),
    (Join-Path ($fwDir -replace 'Framework64', 'Framework') $asm)
  )
  $hit = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($hit) {
    $refs += "/r:`"$hit`""
  } else {
    Write-Host "  ⚠ 找不到引用程序集：$asm（继续，可能编译失败）" -ForegroundColor Yellow
  }
}

Remove-Item $outExe -Force -ErrorAction SilentlyContinue

$cscArgs = @(
  '/nologo'
  '/target:winexe'
  '/platform:anycpu'
  '/optimize+'
  "/out:`"$outExe`""
  "/win32icon:`"$iconFile`""
  "/resource:`"$zipPath`",Payload"
) + $refs + @("`"$csFile`"")

$sw2 = [Diagnostics.Stopwatch]::StartNew()
& $csc @cscArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（exit=$LASTEXITCODE）" }
Write-Host ("编译用时 {0:N1}s" -f $sw2.Elapsed.TotalSeconds)

if (-not (Test-Path $outExe)) { throw '没有产出安装程序' }

# ---------------------------------------------------------------- 4. 收尾
Step '4/4 收尾'
$vi = (Get-Item $outExe).VersionInfo
Write-Host ''
Write-Host ('★ 中文安装程序：' + $outExe) -ForegroundColor Green
Write-Host ("   大小     : {0:N1} MB" -f ((Get-Item $outExe).Length / 1MB))
Write-Host ("   产品名   : {0}" -f $vi.ProductName)
Write-Host '   界面语言 : 简体中文（Windows Forms 自绘）'
Write-Host '   依赖     : 无（.NET Framework 4.x 是 Windows 自带）'

Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue

# ★ 2026-11-05 修：outputs 目录可能不存在（清理后会缺失），以前只在「已存在」时复制，
#   于是脚本打印了「已复制」其实什么都没发生。现在先建目录再复制。
$outputs = 'D:\HMCL-PE重构QCL计划\outputs'
if (-not (Test-Path $outputs)) {
  New-Item -ItemType Directory -Force -Path $outputs | Out-Null
}
Copy-Item $outExe (Join-Path $outputs (Split-Path $outExe -Leaf)) -Force
Write-Host "   已复制到 $outputs"

# ★ 桌面可能被重定向（本机实际是 D:\桌面，而 %USERPROFILE%\Desktop 不存在），
#   所以先用 GetFolderPath 拿真实桌面，再兜底试几个常见位置。
$desktopCandidates = @(
  ([Environment]::GetFolderPath('Desktop')),
  'D:\桌面',
  "$env:USERPROFILE\Desktop"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$copiedDesktop = $false
foreach ($d in $desktopCandidates) {
  try {
    Copy-Item $outExe (Join-Path $d (Split-Path $outExe -Leaf)) -Force
    Write-Host "   已复制到桌面：$d"
    $copiedDesktop = $true
    break
  } catch {
    Write-Host "   桌面复制失败（$d）：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}
if (-not $copiedDesktop) {
  Write-Host '   ⚠ 没找到可写的桌面目录，安装包只在 dist/outputs 里' -ForegroundColor Yellow
}
