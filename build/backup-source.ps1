# QCL 电脑版 · 源码备份脚本
#
# 为什么需要它：
#   安卓版一直有「AI 误删项目」的防护（每次发版前整目录备份成 backup_code_<版本>）。
#   PC 版以前只有 GitHub 远程，本地一份物理备份都没有 —— 这次补上。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build\backup-source.ps1
#   powershell -ExecutionPolicy Bypass -File build\backup-source.ps1 -Label 1.0.2
#
# 备份到 `..\backup_qcl_pc_<版本或时间戳>\`（与安卓版 backup_code_* 同级风格）
# 只备**源码与配置**，排除 node_modules / dist / .cache / 浏览器测试产物 / vendor / .git

param(
  [string]$Label = ''
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$parent = Split-Path -Parent $src

# 版本号：优先用参数，其次读 package.json
if (-not $Label) {
  try {
    $pkg = Get-Content (Join-Path $src 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Label = $pkg.version
  } catch {
    $Label = Get-Date -Format 'yyyyMMdd-HHmmss'
  }
}

$dst = Join-Path $parent "backup_qcl_pc_$Label"
if (Test-Path $dst) {
  $dst = Join-Path $parent ("backup_qcl_pc_$Label-" + (Get-Date -Format 'HHmmss'))
}

Write-Host "源目录: $src"
Write-Host "备份到: $dst"

$exclude = @(
  'node_modules', 'dist', '.cache', '.e2e-home', '.sfx-test', '_probe',
  'vendor', '.git', '.selftest-home', '.content-test3', '.probe-home',
  '_devtest', '_ref', 'build\installer\_work'
)

# ★ robocopy 不会自动建目标根目录，不先建会直接 exit=16（踩过）
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$rcArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', '/MT:8')
foreach ($e in $exclude) {
  $rcArgs += '/XD'
  $rcArgs += (Join-Path $src $e)
}

$sw = [Diagnostics.Stopwatch]::StartNew()
& robocopy @rcArgs *> $null
$code = $LASTEXITCODE
# robocopy: 0=无变化 1=已复制 2=有多余项 3=1+2，>=8 才是真失败
if ($code -ge 8) {
  throw "robocopy 失败（exit=$code）"
}

$files = Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue
$mb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ""
Write-Host "✅ 备份完成：$($files.Count) 个文件 / $mb MB，用时 $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒"
Write-Host "   $dst"
Write-Host ""
Write-Host "提示：这一步只做本地物理备份；源码同时应已推送到"
Write-Host "      https://github.com/ALLEN201123/qcl-pc （远程备份）"
