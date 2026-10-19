[CmdletBinding()]
param(
    [string]$Adb = $(if ($env:BUWEI_ADB_PATH) { $env:BUWEI_ADB_PATH } else { 'D:/Android/Sdk/platform-tools/adb.exe' }),
    [string[]]$Serial = @('emulator-5554', 'emulator-5556'),
    [string]$Package = 'cn.buwei.mobile.nativepreview.debug',
    [string]$Activity = 'cn.buwei.nativeapp.MainActivity',
    [string]$Output = (Join-Path $PSScriptRoot '../../output/android-native'),
    [string]$Apk = '',
    [string]$Dexdump = 'D:/Android/Sdk/build-tools/37.0.0/dexdump.exe',
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Invoke-Adb([string]$Device, [string[]]$Arguments, [switch]$AllowFailure) {
    $result = & $Adb '-s' $Device @Arguments 2>&1
    $exit = $LASTEXITCODE
    $value = ($result | ForEach-Object { "$_" }) -join "`n"
    if ($exit -ne 0 -and !$AllowFailure) { throw "ADB $Device $($Arguments -join ' ') failed: $value" }
    return $value
}
function Inspect-Tree([string]$Text, [string]$ExpectedPackage) {
    [xml]$tree = $Text
    $nodes = @($tree.SelectNodes('//node'))
    $appNodes = @($nodes | Where-Object { $_.GetAttribute('package') -eq $ExpectedPackage })
    return @{
        appNodeCount = $appNodes.Count
        webViewNodeCount = @($appNodes | Where-Object { $_.GetAttribute('class') -match '(?i)webview' }).Count
        text = @($appNodes | ForEach-Object { $_.GetAttribute('text'); $_.GetAttribute('content-desc') } | Where-Object { $_ } | Select-Object -Unique)
    }
}
if ($ValidateOnly) {
    $fixture = '<hierarchy><node package="test.app" class="android.view.View" text="登录" content-desc=""/><node package="other.app" class="android.webkit.WebView" text="" content-desc=""/></hierarchy>'
    $checked = Inspect-Tree $fixture 'test.app'
    if ($checked.appNodeCount -ne 1 -or $checked.webViewNodeCount -ne 0) { throw 'UI tree attribution self-test failed' }
    Write-Output 'PASS: XML parsing and package-specific WebView detection; no device operations.'
    return
}
if (!(Test-Path -LiteralPath $Adb)) { throw "ADB not found: $Adb" }
foreach ($identifier in @($Package, $Activity)) { if ($identifier -notmatch '^[A-Za-z0-9_.]+$') { throw 'Invalid package/activity identifier' } }
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$directory = Join-Path (Resolve-Path -LiteralPath $Output) ('smoke-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $directory | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
foreach ($device in $Serial) {
    if ($device -notmatch '^[A-Za-z0-9_.:-]+$') { throw 'Invalid device identifier' }
    $result = @{ serial = $device; package = $Package; status = 'failed'; limitations = @('Initial unauthenticated screen only', 'Screenshot requires human visual inspection', 'UI tree absence of WebView alone is not a dependency audit', 'No login, production writes, or authenticated acceptance performed') }
    try {
        if ((Invoke-Adb $device @('shell', 'pm', 'path', $Package) -AllowFailure) -notmatch '(?m)^package:') { throw 'Native APK is not installed' }
        $result.screen = Invoke-Adb $device @('shell', 'wm', 'size')
        $result.density = Invoke-Adb $device @('shell', 'wm', 'density')
        $result.model = (Invoke-Adb $device @('shell', 'getprop', 'ro.product.model')).Trim()
        $launch = Invoke-Adb $device @('shell', 'am', 'start', '-W', '-n', "$Package/$Activity")
        Set-Content -LiteralPath (Join-Path $directory "$device-launch.txt") -Value $launch -Encoding utf8
        if ($launch -notmatch '(?m)^Status:\s*ok\s*$') { throw 'Activity did not start successfully' }
        Start-Sleep -Seconds 2
        $remoteXml = "/sdcard/buwei-native-smoke-$device.xml"
        $remotePng = "/sdcard/buwei-native-smoke-$device.png"
        Invoke-Adb $device @('shell', 'uiautomator', 'dump', $remoteXml) | Out-Null
        Invoke-Adb $device @('pull', $remoteXml, (Join-Path $directory "$device-ui.xml")) | Out-Null
        Invoke-Adb $device @('shell', 'screencap', '-p', $remotePng) | Out-Null
        Invoke-Adb $device @('pull', $remotePng, (Join-Path $directory "$device-screen.png")) | Out-Null
        Invoke-Adb $device @('shell', 'rm', '-f', $remoteXml, $remotePng) | Out-Null
        $checked = Inspect-Tree (Get-Content -Raw -LiteralPath (Join-Path $directory "$device-ui.xml")) $Package
        $result.ui = $checked
        if ($checked.appNodeCount -eq 0) { throw 'No native application nodes; a system dialog may cover the app' }
        if ($checked.webViewNodeCount -gt 0) { throw 'WebView class found in native application UI tree' }
        if (($checked.text -join ' ') -notmatch '登录|登入|Sign in|Log in') { throw 'Expected login text not observed; inspect screenshot before accepting' }
        $result.status = 'passed-initial-screen'
    } catch { $result.error = $_.Exception.Message }
    $results.Add($result)
    Write-Output "$device : $($result.status)"
}
$static = @{ status = 'not-requested'; limitations = @('DEX class-reference scan only; matches in unused libraries require review; absence is not full dependency proof') }
if ($Apk) {
    try {
        if (!(Test-Path -LiteralPath $Apk) -or !(Test-Path -LiteralPath $Dexdump)) { throw 'APK or dexdump not found' }
        $static.apk = (Resolve-Path -LiteralPath $Apk).Path
        $static.sha256 = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash.ToLowerInvariant()
        $static.bytes = (Get-Item -LiteralPath $Apk).Length
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($static.apk)
        try {
            $references = [System.Collections.Generic.List[string]]::new()
            $dexEntries = @($archive.Entries | Where-Object { $_.FullName -match '^classes\d*\.dex$' })
            if (!$dexEntries.Count) { throw 'No DEX files found in APK' }
            foreach ($entry in $dexEntries) {
                $dexPath = Join-Path $directory $entry.Name
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dexPath, $true)
                $dexOutput = & $Dexdump '-d' $dexPath 2>&1
                if ($LASTEXITCODE -ne 0) { throw "Dexdump failed for $($entry.Name)" }
                foreach ($line in $dexOutput | Where-Object { "$_" -match 'Landroid/webkit/WebView;' }) { $references.Add("$($entry.Name): $line") }
            }
            $static.webViewReferences = @($references)
            $static.status = if ($references.Count) { 'webview-reference-found-review-required' } else { 'no-webview-reference-observed' }
        } finally { $archive.Dispose() }
    } catch { $static.status = 'failed'; $static.error = $_.Exception.Message }
}
@{ recordedAt = (Get-Date).ToUniversalTime().ToString('o'); devices = @($results); staticAudit = $static } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $directory 'report.json') -Encoding utf8
Write-Output "Report: $(Join-Path $directory 'report.json')"
if (@($results | Where-Object { $_.status -ne 'passed-initial-screen' }).Count -or $static.status -eq 'failed' -or $static.status -eq 'webview-reference-found-review-required') { throw 'Smoke checks incomplete or failed; inspect report and screenshots' }
