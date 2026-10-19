param(
    [Parameter(Mandatory=$true)][string]$PublishDirectory,
    [Parameter(Mandatory=$true)][string]$RuntimeInstaller,
    [string]$Version = '0.1.0',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../artifacts'),
    [string]$SignatureFile,
    [string]$ManifestSignatureFile,
    [string]$ReleaseUrl
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Version must contain only numeric components.' }
$publishPath = (Resolve-Path -LiteralPath $PublishDirectory).Path
$runtimePath = (Resolve-Path -LiteralPath $RuntimeInstaller).Path
if (!(Test-Path -LiteralPath (Join-Path $publishPath 'Buwei.Windows.Native.exe'))) { throw 'Publish directory does not contain Buwei.Windows.Native.exe.' }
if (!(Test-Path -LiteralPath (Join-Path $publishPath 'coreclr.dll'))) { throw 'Expected self-contained .NET publish output.' }
$licensePath = Join-Path $publishPath 'licenses'
if (Get-ChildItem -LiteralPath $publishPath -Recurse -Filter '*WebView2*' | Where-Object { !$_.FullName.StartsWith($licensePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }) { throw 'WebView2 dependency is forbidden in the native package.' }
$authenticode = Get-AuthenticodeSignature -LiteralPath $runtimePath
if ($authenticode.Status -ne 'Valid' -or $authenticode.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Runtime installer must have a valid Microsoft Authenticode signature.' }
$nsisCandidates = @((Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'), 'C:\Program Files (x86)\NSIS\makensis.exe')
$nsis = $nsisCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$nsis) { throw 'NSIS makensis.exe was not found.' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = (Resolve-Path -LiteralPath $OutputDirectory).Path
$installer = Join-Path $outputPath "Buwei.Windows.Native-$Version-x64.exe"
& $nsis '/INPUTCHARSET' 'UTF8' "/DPUBLISH_DIR=$publishPath" "/DRUNTIME_INSTALLER=$runtimePath" "/DAPP_VERSION=$Version" "/DOUTPUT_FILE=$installer" (Join-Path $PSScriptRoot '../installer/Buwei.Native.nsi')
if ($LASTEXITCODE -ne 0) { throw "NSIS failed: $LASTEXITCODE" }
Compress-Archive -Path (Join-Path $publishPath '*') -DestinationPath (Join-Path $outputPath "Buwei.Windows.Native-$Version-x64-portable.zip") -Force
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $(Split-Path -Leaf $installer)" | Set-Content -LiteralPath ($installer + '.sha256') -Encoding utf8NoBOM
if ($SignatureFile -or $ManifestSignatureFile -or $ReleaseUrl) {
    if (!$SignatureFile -or !$ManifestSignatureFile -or !$ReleaseUrl) { throw 'Signed release requires SignatureFile, ManifestSignatureFile and ReleaseUrl together. No signing keys are generated.' }
    $url = [Uri]$ReleaseUrl
    if ($url.Scheme -ne 'https' -or $url.Host -ne 'github.com') { throw 'Release URL must be an HTTPS github.com release asset.' }
    $signature = (Get-Content -LiteralPath $SignatureFile -Raw).Trim()
    $manifest = [ordered]@{channel='windows-native';architecture='x64';version=$Version;url=$ReleaseUrl;signature=$signature;sha256=$hash;sizeBytes=(Get-Item -LiteralPath $installer).Length}
    $manifestPath = Join-Path $outputPath 'windows-native.json'
    [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath $ManifestSignatureFile -Destination ($manifestPath + '.sig') -Force
    # Both signatures are verified by the same production-key implementation used by the app.
    & dotnet run --project (Join-Path $PSScriptRoot '../Platform.Tests/Buwei.Platform.Tests.csproj') -c Release -- --verify-release $installer $SignatureFile $manifestPath ($manifestPath + '.sig')
    if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $manifestPath,($manifestPath + '.sig') -Force; throw 'Release signature verification failed. Update manifest removed.' }
}
Write-Output "Local installer: $installer"
Write-Output "SHA256: $hash"
if (!$SignatureFile) { Write-Output 'Local artifacts only: no update manifest created; signing keys were not accessed.' }
