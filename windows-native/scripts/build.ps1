param([switch]$Debug, [switch]$Package, [string]$RuntimeInstaller)
$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path $PSScriptRoot -Parent
$configuration = if ($Debug) { 'Debug' } else { 'Release' }
if ($RuntimeInstaller) { $RuntimeInstaller = (Resolve-Path -LiteralPath $RuntimeInstaller).Path }
Push-Location $nativeRoot
try {
    $sdk = & dotnet --version
    if ($sdk -notmatch '^10\.0\.') { throw "A .NET 10 SDK is required; found $sdk" }
    & node scripts/generate-contracts.mjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Generated contracts are stale.' }
    & dotnet restore App/Buwei.Windows.csproj --locked-mode -p:Platform=x64
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency restore failed.' }
    if ($Debug) { & dotnet build App/Buwei.Windows.csproj -c $configuration -p:Platform=x64 --no-restore }
    else { & dotnet publish App/Buwei.Windows.csproj -c $configuration -p:Platform=x64 --no-restore -o artifacts/final }
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    if (!$Debug) { & (Join-Path $PSScriptRoot 'collect-licenses.ps1') -PublishDirectory (Join-Path $nativeRoot 'artifacts/final') }
    if ($Package) {
        if ($Debug) { throw 'Debug synthetic fixture builds must never be packaged.' }
        if (!$RuntimeInstaller) { throw 'Provide the verified Microsoft Windows App Runtime 2.5.1 x64 installer.' }
        $fileVersion = [Version](Get-Item -LiteralPath (Join-Path $nativeRoot 'artifacts/final/Buwei.Windows.Native.exe')).VersionInfo.FileVersion
        $packageVersion = '{0}.{1}.{2}' -f $fileVersion.Major, $fileVersion.Minor, $fileVersion.Build
        & (Join-Path $PSScriptRoot 'package.ps1') -PublishDirectory (Join-Path $nativeRoot 'artifacts/final') -RuntimeInstaller $RuntimeInstaller -Version $packageVersion
    }
} finally { Pop-Location }
