[CmdletBinding()]
param(
    [string]$Adb = $(if ($env:BUWEI_ADB_PATH) { $env:BUWEI_ADB_PATH } else { 'D:/Android/Sdk/platform-tools/adb.exe' }),
    [string]$Serial = 'emulator-5556',
    [string]$NativePackage = 'cn.buwei.mobile.nativepreview.debug',
    [string]$NativeActivity = 'cn.buwei.nativeapp.MainActivity',
    [string]$LegacyPackage = 'cn.buwei.mobile',
    [ValidateRange(5, 50)][int]$Trials = 5,
    [ValidateRange(1, 60)][int]$SettleSeconds = 5,
    [ValidateRange(1, 60)][int]$CpuSampleSeconds = 3,
    [string]$Output = (Join-Path $PSScriptRoot '../../output/android-native'),
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Adb([string[]]$Arguments, [switch]$AllowFailure) {
    $result = & $Adb '-s' $Serial @Arguments 2>&1
    $exit = $LASTEXITCODE
    $value = ($result | ForEach-Object { "$_" }) -join "`n"
    if ($exit -ne 0 -and !$AllowFailure) { throw "ADB $($Arguments -join ' ') failed ($exit): $value" }
    return $value
}
function Median([object[]]$Values) {
    $valid = @($Values | Where-Object { $null -ne $_ } | Sort-Object)
    if (!$valid.Count) { return $null }
    $middle = [int][Math]::Floor($valid.Count / 2)
    if ($valid.Count % 2) { return $valid[$middle] }
    return ($valid[$middle - 1] + $valid[$middle]) / 2.0
}
function Stats([object[]]$Values) {
    $valid = @($Values | Where-Object { $null -ne $_ })
    if (!$valid.Count) { return @{ samples = 0; median = $null; min = $null; max = $null } }
    $measure = $valid | Measure-Object -Minimum -Maximum
    return @{ samples = $valid.Count; median = (Median $valid); min = $measure.Minimum; max = $measure.Maximum }
}
function Read-Processes([string]$Package, [string]$PsText, [string]$ActivityText) {
    $found = @{}
    foreach ($line in $PsText -split "`n") {
        if ($line -match '^\s*(\d+)\s+(\d+)\s+(\S+)\s*$') {
            $name = $Matches[3]
            if ($name -eq $Package -or $name.StartsWith("${Package}:")) {
                $found[$Matches[1]] = @{ pid = [int]$Matches[1]; name = $name; attribution = 'exact-package-process-name' }
            }
        }
    }
    # Isolated Chromium renderers do not share the app UID or parent PID. Only Android's
    # own ProcessRecord.packageList provides attribution here; names alone are insufficient.
    $blocks = [regex]::Matches($ActivityText, '(?ms)^\s*\*APP\*[^\r\n]*ProcessRecord\{\S+\s+(\d+):([^/\r\n]+)/[^\r\n]+\r?\n(.*?)(?=^\s*\*APP\*|\z)')
    foreach ($block in $blocks) {
        $list = [regex]::Match($block.Groups[3].Value, 'packageList=\{([^}]+)\}')
        if (!$list.Success) { continue }
        $packages = @($list.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() })
        $processId = $block.Groups[1].Value
        if ($packages -contains $Package -and !$found.ContainsKey($processId)) {
            $found[$processId] = @{ pid = [int]$processId; name = $block.Groups[2].Value; attribution = 'activity-process-record-packageList' }
        }
    }
    return @($found.Values | Sort-Object pid)
}
function Read-Ticks([int]$ProcessId) {
    $stat = Invoke-Adb @('shell', 'cat', "/proc/$ProcessId/stat") -AllowFailure
    # comm may contain spaces and parentheses; fields after its last closing parenthesis begin at field 3.
    $end = $stat.LastIndexOf(')')
    if ($end -lt 0) { return $null }
    $fields = @($stat.Substring($end + 1).Trim() -split '\s+')
    if ($fields.Count -lt 13) { return $null }
    [long]$userTicks = 0; [long]$systemTicks = 0
    if (![long]::TryParse($fields[11], [ref]$userTicks) -or ![long]::TryParse($fields[12], [ref]$systemTicks)) { return $null }
    return $userTicks + $systemTicks
}
function Get-Pss([string]$Text) {
    $match = [regex]::Match($Text, '(?m)^\s*TOTAL PSS:\s*(\d+)')
    if (!$match.Success) { $match = [regex]::Match($Text, '(?m)^\s*TOTAL\s+(\d+)\s') }
    if ($match.Success) { return [long]$match.Groups[1].Value }
    return $null
}
if ($ValidateOnly) {
    $fixture = "  PID PPID NAME`n12 1 test.app`n13 1 test.app:worker`n99 1 com.google.android.webview:sandboxed"
    $activity = "  *APP* UID 99000 ProcessRecord{abc 99:com.google.android.webview:sandboxed/u0ai0}`n    packageList={test.app}`n  *APP* UID 99001 ProcessRecord{def 98:webview:other/u0ai1}`n    packageList={other.app}`n"
    $parsed = @(Read-Processes 'test.app' $fixture $activity)
    if ($parsed.Count -ne 3 -or @($parsed | Where-Object { $_.pid -eq 98 }).Count) { throw 'Process attribution self-test failed' }
    if ((Median @(3, 1, 2, $null)) -ne 2 -or (Median @(4, 1, 2, 3)) -ne 2.5) { throw 'Median self-test failed' }
    if ((Get-Pss ' TOTAL PSS: 1234 TOTAL RSS: 2345') -ne 1234) { throw 'PSS self-test failed' }
    Write-Output 'PASS: benchmark parsers, exact process attribution, medians; no device operations.'
    return
}
if (!(Test-Path -LiteralPath $Adb)) { throw "ADB not found: $Adb" }
foreach ($identifier in @($NativePackage, $NativeActivity, $LegacyPackage)) {
    if ($identifier -notmatch '^[A-Za-z0-9_.]+$') { throw 'Invalid package/activity identifier' }
}
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$reportDirectory = Join-Path (Resolve-Path -LiteralPath $Output) ("benchmark-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$Serial")
New-Item -ItemType Directory -Path $reportDirectory | Out-Null
$metadata = @{
    serial = $Serial; startedAt = (Get-Date).ToUniversalTime().ToString('o'); trials = $Trials
    scenario = 'Initial screen after force-stop; expected unauthenticated, verify with companion smoke capture; no input or authentication performed'
    coldDefinition = 'Process cold start only; storage/page cache and compilation cache are not cleared'
    device = (Invoke-Adb @('shell', 'getprop', 'ro.product.model')).Trim()
    sdk = (Invoke-Adb @('shell', 'getprop', 'ro.build.version.sdk')).Trim()
    abi = (Invoke-Adb @('shell', 'getprop', 'ro.product.cpu.abilist')).Trim()
    screen = Invoke-Adb @('shell', 'wm', 'size'); density = Invoke-Adb @('shell', 'wm', 'density')
    settleSeconds = $SettleSeconds; cpuSampleSeconds = $CpuSampleSeconds
    cpuDefinition = 'Process CPU core-equivalent percent from /proc/stat tick deltas; null if access or attribution incomplete'
    limitations = @('Initial-screen comparison only; authentication state must be confirmed from companion smoke capture', 'No full authenticated feature/resource equivalence', 'No controlled scrolling; gfxinfo covers startup/idle frames only', 'Emulator timing, CPU and memory do not establish real-device battery behavior', 'PSS excludes shared system services that Android does not attribute to this package', 'A legacy total is null when isolated renderer attribution is unresolved')
}
$tickText = (Invoke-Adb @('shell', 'getconf', 'CLK_TCK') -AllowFailure).Trim()
[long]$tickHz = 0
$tickKnown = [long]::TryParse($tickText, [ref]$tickHz) -and $tickHz -gt 0
$metadata.cpuClockTicksPerSecond = $(if ($tickKnown) { $tickHz } else { $null })
$metadata.packages = @{}
foreach ($package in @($NativePackage, $LegacyPackage)) {
    $details = Invoke-Adb @('shell', 'dumpsys', 'package', $package) -AllowFailure
    Set-Content -LiteralPath (Join-Path $reportDirectory "$package-package.txt") -Value $details -Encoding utf8
    $paths = @((Invoke-Adb @('shell', 'pm', 'path', $package) -AllowFailure) -split "`n" | Where-Object { $_ -match '^package:' } | ForEach-Object { $_.Substring(8).Trim() })
    [long]$apkBytes = 0; $apkSizeKnown = $paths.Count -gt 0
    foreach ($apkPath in $paths) {
        [long]$bytes = 0
        if ([long]::TryParse((Invoke-Adb @('shell', 'stat', '-c', '%s', $apkPath) -AllowFailure).Trim(), [ref]$bytes)) { $apkBytes += $bytes } else { $apkSizeKnown = $false }
    }
    $metadata.packages[$package] = @{ debuggable = $details -match '(?m)flags=\[[^\]]*DEBUGGABLE'; installedApkBytes = $(if ($apkSizeKnown) { $apkBytes } else { $null }); installedApkPaths = $paths }
}
$results = [System.Collections.Generic.List[object]]::new()
$packages = @(@{ label = 'native'; name = $NativePackage; activity = $NativeActivity }, @{ label = 'legacy'; name = $LegacyPackage; activity = $null })
for ($trial = 1; $trial -le $Trials; $trial++) {
    foreach ($candidate in $packages) {
        $package = $candidate.name
        $prefix = "trial-$trial-$($candidate.label)"
        $packagePath = Invoke-Adb @('shell', 'pm', 'path', $package) -AllowFailure
        if ($packagePath -notmatch '(?m)^package:') {
            $results.Add(@{ trial = $trial; label = $candidate.label; package = $package; status = 'not-installed'; totalTimeMs = $null; relatedPssKiB = $null; idleCpuPercent = $null }); continue
        }
        # Stop both candidates so the comparison does not count a second foreground app's work.
        foreach ($stopPackage in @($NativePackage, $LegacyPackage)) { Invoke-Adb @('shell', 'am', 'force-stop', $stopPackage) | Out-Null }
        $component = if ($candidate.activity) { "$package/$($candidate.activity)" } else {
            ((Invoke-Adb @('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', $package)) -split "`n" | Where-Object { $_ -match '^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$' } | Select-Object -Last 1)
        }
        if (!$component) { throw "Cannot resolve launcher for $package" }
        Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $package, 'reset') -AllowFailure | Out-Null
        $launch = Invoke-Adb @('shell', 'am', 'start', '-W', '-n', $component)
        Set-Content -LiteralPath (Join-Path $reportDirectory "$prefix-launch.txt") -Value $launch -Encoding utf8
        if ($launch -notmatch '(?m)^Status:\s*ok\s*$' -or $launch -match '(?m)^Error:') { throw "Launch did not succeed for $package : $launch" }
        Start-Sleep -Seconds $SettleSeconds
        $ps = Invoke-Adb @('shell', 'ps', '-A', '-o', 'PID,PPID,NAME')
        $activity = Invoke-Adb @('shell', 'dumpsys', 'activity', 'processes')
        Set-Content -LiteralPath (Join-Path $reportDirectory "$prefix-processes.txt") -Value "$ps`n`n$activity" -Encoding utf8
        $processes = @(Read-Processes $package $ps $activity)
        $ticksBefore = @{}
        foreach ($process in $processes) { $ticksBefore[$process.pid] = @{ ticks = (Read-Ticks $process.pid); at = [Diagnostics.Stopwatch]::GetTimestamp() } }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        Start-Sleep -Seconds $CpuSampleSeconds
        $elapsed = $clock.Elapsed.TotalSeconds
        $cpuComplete = $tickKnown -and $processes.Count -gt 0; [double]$cpuPercent = 0
        foreach ($process in $processes) {
            $after = Read-Ticks $process.pid; $at = [Diagnostics.Stopwatch]::GetTimestamp(); $before = $ticksBefore[$process.pid]
            $window = ($at - $before.at) / [double][Diagnostics.Stopwatch]::Frequency
            if ($null -eq $after -or $null -eq $before.ticks -or $after -lt $before.ticks -or !$tickKnown) { $cpuComplete = $false; $process.idleCpuPercent = $null }
            else { $process.idleCpuPercent = [Math]::Round(($after - $before.ticks) / $tickHz / $window * 100, 3); $cpuPercent += $process.idleCpuPercent }
            $process.cpuReadWindowSeconds = $window
        }
        $afterProcesses = @(Read-Processes $package (Invoke-Adb @('shell', 'ps', '-A', '-o', 'PID,PPID,NAME')) (Invoke-Adb @('shell', 'dumpsys', 'activity', 'processes')))
        $processSetStable = (@($processes | ForEach-Object { $_.pid }) -join ',') -eq (@($afterProcesses | ForEach-Object { $_.pid }) -join ',')
        if (!$processSetStable) { $cpuComplete = $false }
        $pssComplete = $processes.Count -gt 0; [long]$totalPss = 0; [long]$appPss = 0
        foreach ($process in $processes) {
            $memory = Invoke-Adb @('shell', 'dumpsys', 'meminfo', "$($process.pid)") -AllowFailure
            Set-Content -LiteralPath (Join-Path $reportDirectory "$prefix-mem-$($process.pid).txt") -Value $memory -Encoding utf8
            $pss = Get-Pss $memory; $process.pssKiB = $pss
            if ($null -eq $pss) { $pssComplete = $false } else { $totalPss += $pss; if ($process.attribution -eq 'exact-package-process-name') { $appPss += $pss } }
        }
        $renderers = @($processes | Where-Object { $_.attribution -eq 'activity-process-record-packageList' -and $_.name -match 'sandboxed|SandboxedProcess|webview' })
        $rendererResolved = $candidate.label -ne 'legacy' -or $renderers.Count -gt 0
        $gfx = Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $package, 'framestats')
        Set-Content -LiteralPath (Join-Path $reportDirectory "$prefix-gfxinfo.txt") -Value $gfx -Encoding utf8
        $timeMatch = [regex]::Match($launch, '(?m)^TotalTime:\s*(\d+)')
        $frameMatch = [regex]::Match($gfx, 'Total frames rendered:\s*(\d+)')
        $jankMatch = [regex]::Match($gfx, 'Janky frames:\s*(\d+)\s*\(([\d.]+)%\)')
        $results.Add(@{
            trial = $trial; label = $candidate.label; package = $package; status = 'measured'; component = $component
            totalTimeMs = $(if ($timeMatch.Success) { [int]$timeMatch.Groups[1].Value } else { $null })
            appProcessPssKiB = $appPss; attributedPssKiB = $(if ($pssComplete) { $totalPss } else { $null })
            relatedPssKiB = $(if ($pssComplete -and $rendererResolved) { $totalPss } else { $null })
            rendererAttribution = $(if ($renderers.Count) { 'resolved-by-activity-packageList' } elseif ($candidate.label -eq 'legacy') { 'unresolved-do-not-compare-total' } else { 'no-attributed-renderer-observed' })
            idleCpuPercent = $(if ($cpuComplete -and $rendererResolved) { [Math]::Round($cpuPercent, 3) } else { $null })
            processSetStableDuringCpuSample = $processSetStable
            cpuSampleElapsedSeconds = $elapsed; processes = $processes
            frames = $(if ($frameMatch.Success) { [int]$frameMatch.Groups[1].Value } else { $null })
            jankyFramePercent = $(if ($jankMatch.Success) { [double]$jankMatch.Groups[2].Value } else { $null })
        })
        Write-Output "Measured trial $trial/$Trials $($candidate.label) on $Serial"
    }
}
$summary = @{}
foreach ($label in @('native', 'legacy')) {
    $group = @($results | Where-Object { $_.label -eq $label -and $_.status -eq 'measured' })
    $summary[$label] = @{ measuredTrials = $group.Count; coldStartMs = Stats @($group | ForEach-Object { $_.totalTimeMs }); relatedPssKiB = Stats @($group | ForEach-Object { $_.relatedPssKiB }); idleCpuPercent = Stats @($group | ForEach-Object { $_.idleCpuPercent }) }
}
@{ metadata = $metadata; summary = $summary; trials = @($results) } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $reportDirectory 'report.json') -Encoding utf8
Write-Output "Report: $(Join-Path $reportDirectory 'report.json')"
