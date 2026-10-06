param([ValidateSet('0.1.0','0.1.1')][string]$Version = '0.1.0', [Parameter(Mandatory)][string]$SigningKeyPath)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$oldSigningKey = $env:TAURI_SIGNING_PRIVATE_KEY
$oldSmoke = $env:BUWEI_DESKTOP_SMOKE
$oldDevOrigin = $env:BUWEI_DESKTOP_DEV_ORIGIN
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $SigningKeyPath).Path
    $env:BUWEI_DESKTOP_SMOKE = '1'
    $env:BUWEI_DESKTOP_DEV_ORIGIN = 'http://127.0.0.1:5173'
    $versionConfig = @{ version = $Version; productName = '补位测试' } | ConvertTo-Json -Compress
    Push-Location $desktopRoot
    try {
        & npm run tauri -- build --debug --bundles nsis --config src-tauri/tauri.smoke.conf.json --config $versionConfig
        if ($LASTEXITCODE -ne 0) { throw 'Smoke signed installer build failed' }
    } finally { Pop-Location }
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $oldSigningKey
    $env:BUWEI_DESKTOP_SMOKE = $oldSmoke
    $env:BUWEI_DESKTOP_DEV_ORIGIN = $oldDevOrigin
}
