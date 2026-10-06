param([string]$SigningKeyPath, [switch]$Unsigned)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$oldKey = $env:TAURI_SIGNING_PRIVATE_KEY
$oldPath = $env:PATH
try {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        $rustBin = Join-Path $env:USERPROFILE '.cargo/bin'
        if (-not (Test-Path -LiteralPath (Join-Path $rustBin 'cargo.exe'))) { throw 'Rust MSVC toolchain is required; see desktop/README.md.' }
        $env:PATH = $rustBin + ';' + $env:PATH
    }
    if (-not $Unsigned) {
        if ($SigningKeyPath) { $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $SigningKeyPath).Path }
        if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'Provide -SigningKeyPath or TAURI_SIGNING_PRIVATE_KEY. Never commit the private key.' }
    }
    Push-Location $desktopRoot
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        if ($Unsigned) {
            & npm run tauri -- build --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'
        } else { & npm run tauri -- build --bundles nsis }
        if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed' }
    } finally { Pop-Location }
} finally { $env:TAURI_SIGNING_PRIVATE_KEY = $oldKey; $env:PATH = $oldPath }
