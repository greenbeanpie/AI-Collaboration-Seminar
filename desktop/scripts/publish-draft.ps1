param([Parameter(Mandatory)][string]$Installer, [string]$NotesFile, [string]$TargetCommitish, [switch]$ReplaceDraftAssets)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$config = Get-Content -LiteralPath (Join-Path $desktopRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$version = $config.version
if (-not $TargetCommitish) { $TargetCommitish = (& git rev-parse HEAD).Trim(); if ($LASTEXITCODE -ne 0) { throw 'Git source commit unavailable' } }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$distributionPath = Join-Path (Split-Path $installerPath -Parent) "buwei-$version-windows-x64-setup.exe"
if ($installerPath -ne $distributionPath) {
    Copy-Item -LiteralPath $installerPath -Destination $distributionPath
    Copy-Item -LiteralPath "$installerPath.sig" -Destination "$distributionPath.sig"
    $installerPath = $distributionPath
}
$manifestPath = Join-Path (Split-Path $installerPath -Parent) 'latest.json'
$manifestArgs = @((Join-Path $PSScriptRoot 'release-manifest.mjs'), $version, $installerPath, $manifestPath)
if ($NotesFile) { $manifestArgs += (Resolve-Path -LiteralPath $NotesFile).Path }
& node @manifestArgs
if ($LASTEXITCODE -ne 0) { throw 'Manifest generation failed' }
$notes = if ($NotesFile) { Get-Content -LiteralPath $NotesFile -Raw } else { 'Windows x64 client. Awaiting installation and upgrade acceptance.' }
if (Get-Command gh -ErrorAction SilentlyContinue) {
    $releaseArgs = @('release', 'create', "desktop-v$version", $installerPath, "$installerPath.sig", $manifestPath, '--repo', 'greenbeanpie/AI-Colleboration-Seminar', '--target', $TargetCommitish, '--draft', '--title', "补位 Windows $version")
    if ($NotesFile) { $releaseArgs += @('--notes-file', (Resolve-Path -LiteralPath $NotesFile).Path) } else { $releaseArgs += @('--notes', $notes) }
    & gh @releaseArgs
    if ($LASTEXITCODE -ne 0) { throw 'Draft release creation failed; inspect existing releases before retrying.' }
    return
}

# A non-interactive HTTPS credential may already be configured by Git Credential Manager.
# Keep it in this process only: never write it, print it, or pass it on a command line.
$previousInteractive = $env:GCM_INTERACTIVE
$releaseToken = $env:GH_TOKEN
if (-not $releaseToken) { $releaseToken = $env:GITHUB_TOKEN }
try {
    if (-not $releaseToken) {
        $env:GCM_INTERACTIVE = 'Never'
        $credentialLines = "protocol=https`nhost=github.com`n`n" | & git -c credential.interactive=never credential fill 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'No GitHub authentication available. Configure gh or GH_TOKEN.' }
        $releaseToken = (($credentialLines | Where-Object { $_ -like 'password=*' }) -replace '^password=', '')
        $credentialLines = $null
    }
    if (-not $releaseToken) { throw 'GitHub credential unavailable' }
    $headers = @{ Authorization = "Bearer $releaseToken"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2026-03-10' }
    $baseUri = 'https://api.github.com/repos/greenbeanpie/AI-Colleboration-Seminar'
    $releases = Invoke-RestMethod -Uri "$baseUri/releases?per_page=100" -Headers $headers
    $matching = @($releases | Where-Object { $_.tag_name -eq "desktop-v$version" })
    if ($matching.Count -gt 1 -or ($matching.Count -eq 1 -and -not $matching[0].draft)) { throw 'Release already published or ambiguous; do not overwrite.' }
    if ($matching.Count) {
        $release = $matching[0]
        if ($ReplaceDraftAssets) {
            $updatedPayload = @{ target_commitish = $TargetCommitish; body = $notes; draft = $true } | ConvertTo-Json
            $release = Invoke-RestMethod -Method Patch -Uri "$baseUri/releases/$($release.id)" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($updatedPayload))
        }
    } else {
        $payload = @{ tag_name = "desktop-v$version"; target_commitish = $TargetCommitish; name = "补位 Windows $version"; body = $notes; draft = $true; prerelease = $false; make_latest = 'false' } | ConvertTo-Json
        $release = Invoke-RestMethod -Method Post -Uri "$baseUri/releases" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload))
    }
    foreach ($assetPath in @($installerPath, "$installerPath.sig", $manifestPath)) {
        $assetName = Split-Path $assetPath -Leaf
        $digest = 'sha256:' + (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $existing = @($release.assets | Where-Object { $_.name -eq $assetName })
        if ($existing.Count) {
            if ($existing.Count -eq 1 -and $existing[0].digest -eq $digest) { continue }
            if ($existing.Count -ne 1 -or -not $ReplaceDraftAssets) { throw "Existing draft asset differs: $assetName. Inspect before replacing." }
            # This flag applies only to the already-verified unpublished draft, never a public release.
            Invoke-RestMethod -Method Delete -Uri "$baseUri/releases/assets/$($existing[0].id)" -Headers $headers | Out-Null
        }
        $assetUri = "https://uploads.github.com/repos/greenbeanpie/AI-Colleboration-Seminar/releases/$($release.id)/assets?name=$([Uri]::EscapeDataString($assetName))"
        $uploaded = Invoke-RestMethod -Method Post -Uri $assetUri -Headers $headers -ContentType 'application/octet-stream' -InFile $assetPath
        if ($uploaded.state -ne 'uploaded' -or $uploaded.digest -ne $digest) { throw "Uploaded asset verification failed: $assetName" }
    }
    [pscustomobject]@{ Draft = $release.draft; Url = $release.html_url; SourceCommit = $TargetCommitish; Version = $version }
} finally {
    $releaseToken = $null; $headers = $null; $env:GCM_INTERACTIVE = $previousInteractive
}
