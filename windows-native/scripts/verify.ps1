param()
$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path $PSScriptRoot -Parent
Push-Location $nativeRoot
try {
    & (Join-Path $PSScriptRoot 'package-resources.test.ps1')
    & dotnet restore App/Buwei.Windows.csproj --locked-mode -p:Platform=x64
    if ($LASTEXITCODE -ne 0) { throw 'Locked WinUI dependency restore failed.' }
    & node scripts/generate-contracts.mjs --check
    if ($LASTEXITCODE -ne 0) { throw 'Contracts check failed.' }
    & node --test scripts/contracts.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Contract tests failed.' }
    foreach ($project in @('Tests/Buwei.Windows.Tests.csproj','Regression.Tests/Buwei.Windows.Regression.Tests.csproj','Office.Tests/Buwei.Windows.Office.Tests.csproj','Export.Tests/Buwei.Windows.Export.Tests.csproj','Platform.Tests/Buwei.Platform.Tests.csproj','Platform.Tests/Buwei.Voice.Tests.csproj')) {
        & dotnet run --project $project -c Release
        if ($LASTEXITCODE -ne 0) { throw "Verification failed: $project" }
    }
    & dotnet build App/Buwei.Windows.csproj -c Release -p:Platform=x64 --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'WinUI Release build failed.' }
} finally { Pop-Location }
