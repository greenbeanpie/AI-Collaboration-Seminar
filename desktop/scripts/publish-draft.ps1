param([Parameter(Mandatory)][string]$Installer, [string]$NotesFile)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$config = Get-Content -LiteralPath (Join-Path $desktopRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$manifestPath = Join-Path (Split-Path $installerPath -Parent) 'latest.json'
$manifestArgs = @((Join-Path $PSScriptRoot 'release-manifest.mjs'), $version, $installerPath, $manifestPath)
if ($NotesFile) { $manifestArgs += (Resolve-Path -LiteralPath $NotesFile).Path }
& node @manifestArgs
if ($LASTEXITCODE -ne 0) { throw 'Manifest generation failed' }
$releaseArgs = @('release', 'create', "desktop-v$version", $installerPath, "$installerPath.sig", $manifestPath, '--repo', 'greenbeanpie/AI-Colleboration-Seminar', '--draft', '--title', "补位 Windows $version")
if ($NotesFile) { $releaseArgs += @('--notes-file', $NotesFile) } else { $releaseArgs += @('--notes', 'Windows x64 client. Awaiting installation and upgrade acceptance.') }
& gh @releaseArgs
if ($LASTEXITCODE -ne 0) { throw 'Draft release creation failed; inspect existing releases before retrying.' }
