[CmdletBinding()]
param(
    [string]$Adb = 'D:/Android/Sdk/platform-tools/adb.exe',
    [string]$Serial = '',
    [string]$TestClass = '',
    [string]$Output = (Join-Path $PSScriptRoot '../../output/verification/android-device'),
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Select-TestDevice([string]$Listing, [string]$Requested) {
    $lines = @($Listing -split "`r?`n" | Where-Object { $_ -match '^\S+\s+(device|offline|unauthorized)\b' })
    # Count offline emulators too: an emulator still booting also consumes memory.
    $emulators = @($lines | Where-Object { $_ -match '^emulator-' })
    if ($emulators.Count -gt 1) { throw 'More than one emulator is running. Stop the extra emulator before testing.' }
    $ready = @($lines | Where-Object { $_ -match '^\S+\s+device\b' } | ForEach-Object { ($_ -split '\s+')[0] })
    if ($Requested) {
        if ($Requested -notin $ready) { throw "Selected device is not ready: $Requested" }
        return $Requested
    }
    if ($ready.Count -ne 1) { throw 'Exactly one ready device is required, or specify -Serial.' }
    return $ready[0]
}
function Test-InstrumentationResult([string]$Text) {
    return $Text -match '(?m)^OK \([1-9]\d* tests?\)\s*$' -and $Text -notmatch 'FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed'
}
if ($ValidateOnly) {
    if ((Select-TestDevice "List of devices attached`nemulator-5554`tdevice`n" '') -ne 'emulator-5554') { throw 'Selection failed' }
    foreach ($case in @(
        @{ listing = "emulator-5554`tdevice`nemulator-5556`toffline"; serial = '' },
        @{ listing = "emulator-5554`tdevice`nemulator-5556`toffline"; serial = 'emulator-5554' },
        @{ listing = "emulator-5554`toffline"; serial = 'emulator-5554' },
        @{ listing = ''; serial = '' }
    )) {
        $rejected = $false
        try { Select-TestDevice $case.listing $case.serial | Out-Null } catch { $rejected = $true }
        if (!$rejected) { throw 'Unsafe device inventory accepted' }
    }
    if (!(Test-InstrumentationResult "Time: 1`nOK (1 test)`n")) { throw 'Valid runner result rejected' }
    foreach ($invalid in @('OK (0 tests)', 'INSTRUMENTATION_FAILED', "FAILURES!!!`nOK (1 test)", '')) {
        if (Test-InstrumentationResult $invalid) { throw 'Incomplete or failed runner result accepted' }
    }
    Write-Output 'PASS: single-device selection, multiple-emulator and missing-device guards.'
    return
}
if ($TestClass -and $TestClass -notmatch '^[A-Za-z0-9_.$,#]+$') { throw 'Invalid instrumentation class selector' }
$listing = & $Adb devices -l
if ($LASTEXITCODE) { throw 'Unable to enumerate devices' }
$Serial = Select-TestDevice ($listing -join "`n") $Serial
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
New-Item -ItemType Directory -Force -Path $Output | Out-Null
function Invoke-Adb([string[]]$Arguments) {
    $result = & $Adb -s $Serial @Arguments 2>&1
    if ($LASTEXITCODE) { throw "ADB failed: $($result -join "`n")" }
    return $result
}
# Build first, then run this script after Gradle exits. No emulator or build is launched here.
foreach ($apk in @('app/build/outputs/apk/debug/app-debug.apk', 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')) {
    $path = Join-Path $project $apk
    if (!(Test-Path -LiteralPath $path)) { throw "Build APK first: $path" }
    Invoke-Adb @('install', '-r', $path) | Write-Output
}
$arguments = @('shell', 'am', 'instrument', '-w', '-r')
if ($TestClass) { $arguments += @('-e', 'class', $TestClass) }
$arguments += 'cn.buwei.mobile.nativepreview.debug.test/androidx.test.runner.AndroidJUnitRunner'
$result = & $Adb -s $Serial @arguments 2>&1
$instrumentExit = $LASTEXITCODE
$result | Set-Content -LiteralPath (Join-Path $Output 'instrumentation.txt') -Encoding utf8
$result | Write-Output
if ($instrumentExit -ne 0 -or !(Test-InstrumentationResult ($result -join "`n"))) {
    throw 'Instrumentation failed; inspect instrumentation.txt'
}
