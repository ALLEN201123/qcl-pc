# QCL 电脑版 · 一键打包单文件绿色版 exe
#
# 为什么要这么绕（不用 electron-builder 的 portable target）：
#   NSIS(makensis) 是 32 位程序，会把整个安装包数据映射成一块内存（约 92MB），
#   在本机这种"可用内存常年 1GB 上下"的环境里必然失败：
#     Internal compiler error #12345: error creating mmap the size of 92004923
#   所以改成：electron-builder 只负责产出 win-unpacked（这条链已验证可用），
#   然后我们自己用 7-Zip 打 payload + 用 7z.sfx 拼接成单文件 exe。
#   拼接只是文件复制，不需要任何大内存进程。
#
# 用法：pwsh -File build\make-portable.ps1 [-SkipPack]

param(
  [switch]$SkipPack,
  [string]$Version = '1.0.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # qcl-pc
Set-Location $root

$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
$sfxStub  = 'C:\Program Files\7-Zip\7z.sfx'
if (-not (Test-Path $sevenZip)) { throw "找不到 7-Zip：$sevenZip" }
if (-not (Test-Path $sfxStub))  { throw "找不到 SFX 模块：$sfxStub" }

$dist    = Join-Path $root 'dist'
$unpacked = Join-Path $dist 'win-unpacked'
$payload = Join-Path $dist '_payload.7z'
$config  = Join-Path $dist '_sfx-config.txt'
$stub    = Join-Path $dist '_sfx-stub.exe'
$outExe  = Join-Path $dist "QCL-$Version-win-x64.exe"

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. pack（目录版）
if (-not $SkipPack) {
  Step '1/5 electron-builder --dir（产出 win-unpacked，含图标与版本信息）'
  Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
  & npx electron-builder --config electron-builder.config.js --win --x64 --dir
  if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir 失败（exit=$LASTEXITCODE）" }
}

$qclExe = Join-Path $unpacked 'QCL.exe'
if (-not (Test-Path $qclExe)) { throw "没有 $qclExe，请先跑 npm run pack" }
Write-Host ("win-unpacked: {0:N1} MB" -f ((Get-ChildItem $unpacked -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))

# ---------------------------------------------------------------- 2. 打 payload
Step '2/5 用 7-Zip 压 payload（-mx=5，约 80MB）'
Remove-Item $payload -Force -ErrorAction SilentlyContinue
& $sevenZip a -t7z -mx=5 $payload (Join-Path $unpacked '*') | Select-Object -Last 2
if ($LASTEXITCODE -ne 0) { throw "7z 压缩失败" }
Write-Host ("payload: {0:N1} MB" -f ((Get-Item $payload).Length / 1MB))

# ---------------------------------------------------------------- 3. SFX 配置
Step '3/5 写 SFX 配置（UTF-8 无 BOM）'
$cfg = @(
  ';!@Install@!UTF-8!'
  'Title="QCL 量子方块启动器"'
  'Progress="yes"'
  'RunProgram="QCL.exe"'
  ';!@InstallEnd@!'
) -join "`r`n"
[IO.File]::WriteAllText($config, $cfg + "`r`n", (New-Object Text.UTF8Encoding($false)))
Write-Host (Get-Content $config -Encoding UTF8 | Out-String).Trim()

# ---------------------------------------------------------------- 4. rcedit 引导头
Step '4/5 给 SFX 引导头写 QCL 图标与版本信息'
Copy-Item $sfxStub $stub -Force
$rcedit = Get-ChildItem (Join-Path $root '.cache\builder\winCodeSign') -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $rcedit) {
  $rcedit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
$ico = Join-Path $root 'build\icon.ico'
if ($rcedit -and (Test-Path $ico)) {
  & $rcedit $stub `
    --set-icon $ico `
    --set-version-string 'ProductName' 'QCL' `
    --set-version-string 'FileDescription' 'QCL · 量子方块启动器' `
    --set-version-string 'CompanyName' 'Rod123456' `
    --set-version-string 'LegalCopyright' 'GPL-3.0 · Quanta Craft Launcher' `
    --set-version-string 'OriginalFilename' "QCL-$Version-win-x64.exe" `
    --set-file-version "$Version.0" `
    --set-product-version $Version
  if ($LASTEXITCODE -ne 0) { Write-Warning 'rcedit 失败，引导头将保留 7z 默认图标' }
} else {
  Write-Warning "跳过 rcedit（rcedit=$rcedit, icon=$ico）"
}

# ---------------------------------------------------------------- 5. 拼接
Step '5/5 拼接单文件 exe'
Remove-Item $outExe -Force -ErrorAction SilentlyContinue
cmd /c copy /b "`"$stub`"" + "`"$config`"" + "`"$payload`"" "`"$outExe`"" | Out-Null
if (-not (Test-Path $outExe)) { throw '拼接失败' }

$vi = (Get-Item $outExe).VersionInfo
Write-Host ''
Write-Host ('★ 单文件 exe：' + $outExe) -ForegroundColor Green
Write-Host ("   大小        : {0:N1} MB" -f ((Get-Item $outExe).Length / 1MB))
Write-Host ("   ProductName : {0}" -f $vi.ProductName)
Write-Host ("   描述        : {0}" -f $vi.FileDescription)

# 清掉中间产物（payload 80MB 不留在交付目录）
Remove-Item $payload, $config, $stub -Force -ErrorAction SilentlyContinue
Write-Host '   已清理中间文件'
