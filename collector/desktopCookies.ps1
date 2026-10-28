# 解开抖音桌面端 Local State 里的 Cookie 密钥（Windows DPAPI，当前用户）。
# 只读 %APPDATA%\douyin\Local State，不接受任何外部传入的路径；结果以 64 位十六进制输出。
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $statePath = Join-Path $env:APPDATA 'douyin\Local State'
  if (-not (Test-Path -LiteralPath $statePath)) { exit 1 }
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $blob = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
  if ($blob.Length -le 5) { exit 1 }
  # 前 5 字节是 'DPAPI' 标记
  if ([System.Text.Encoding]::ASCII.GetString($blob[0..4]) -ne 'DPAPI') { exit 1 }
  $payload = New-Object byte[] ($blob.Length - 5)
  [Array]::Copy($blob, 5, $payload, 0, $payload.Length)
  $key = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $null, 'CurrentUser')
  if ($key.Length -ne 32) { exit 1 }
  [Console]::Out.Write((($key | ForEach-Object { $_.ToString('X2') }) -join '').ToLowerInvariant())
  exit 0
} catch {
  exit 1
}
