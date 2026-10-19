[CmdletBinding()]
param(
    [string]$NativeExe,
    [string]$LegacyExe,
    [string]$LegacyIsolationDescription,
    [string[]]$NativeArguments = @(),
    [string[]]$LegacyArguments = @(),
    [ValidateSet('LoginForeground','Tray','Both')][string]$Scenario = 'Both',
    [ValidateRange(1,10)][int]$Trials = 3,
    [ValidateRange(0,120)][int]$WarmupSeconds = 30,
    [ValidateRange(1,300)][int]$SampleSeconds = 60,
    [ValidateRange(100,5000)][int]$IntervalMilliseconds = 1000,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../artifacts/resources'),
    [switch]$AllowTerminateBenchmarkProcesses,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Median([object[]]$Values) {
    $sorted = @($Values | Where-Object { $null -ne $_ } | Sort-Object)
    if (!$sorted.Count) { return $null }
    $middle = [int][Math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2) { return [double]$sorted[$middle] }
    return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2
}
function Expand-ProcessTree([object[]]$Inventory, [Collections.Generic.HashSet[int]]$Known) {
    do {
        $changed = $false
        foreach ($process in $Inventory) {
            if ($Known.Contains([int]$process.ParentProcessId) -and !$Known.Contains([int]$process.ProcessId)) {
                [void]$Known.Add([int]$process.ProcessId); $changed = $true
            }
        }
    } while ($changed)
}
if ($ValidateOnly) {
    if ((Get-Median @(4,1,3,2)) -ne 2.5 -or (Get-Median @(3,1,2)) -ne 2) { throw 'Median verification failed.' }
    $known = [Collections.Generic.HashSet[int]]::new(); [void]$known.Add(100)
    $fixture = @([pscustomobject]@{ProcessId=102;ParentProcessId=101},[pscustomobject]@{ProcessId=999;ParentProcessId=998},[pscustomobject]@{ProcessId=101;ParentProcessId=100})
    Expand-ProcessTree $fixture $known
    if ($known.Count -ne 3 -or $known.Contains(999)) { throw 'Process attribution verification failed.' }
    Write-Output 'PASS: recursive process attribution and median aggregation. No processes launched or sampled.'
    return
}
if (!$NativeExe) { throw 'NativeExe is required.' }
if (!$AllowTerminateBenchmarkProcesses) { throw 'Benchmark trials terminate only the exact processes they launch. Use AllowTerminateBenchmarkProcesses only with a known clean benchmark profile; never use an active work session.' }
if ($LegacyExe -and !$LegacyIsolationDescription) { throw 'LegacyIsolationDescription is required: use a separately built identity/profile, never the user''s real legacy profile.' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputPath = (Resolve-Path -LiteralPath $OutputDirectory).Path
$candidates = @([pscustomobject]@{ Label='winui-native'; Path=(Resolve-Path -LiteralPath $NativeExe).Path; Arguments=$NativeArguments; Isolation='Independent Buwei.Windows.Native identity; caller must confirm anonymous/clean state.' })
if ($LegacyExe) { $candidates += [pscustomobject]@{ Label='tauri-baseline'; Path=(Resolve-Path -LiteralPath $LegacyExe).Path; Arguments=$LegacyArguments; Isolation=$LegacyIsolationDescription } }
$scenarios = if ($Scenario -eq 'Both') { @('LoginForeground','Tray') } else { @($Scenario) }
$allSamples = [Collections.Generic.List[object]]::new()
$processSamples = [Collections.Generic.List[object]]::new()
$trialResults = [Collections.Generic.List[object]]::new()
$logicalProcessors = [Environment]::ProcessorCount
$manifest = [ordered]@{
    startedUtc=[DateTimeOffset]::UtcNow.ToString('O'); machine=$env:COMPUTERNAME; os=[Environment]::OSVersion.VersionString
    logicalProcessors=$logicalProcessors; trials=$Trials; warmupSeconds=$WarmupSeconds; sampleSeconds=$SampleSeconds; intervalMilliseconds=$IntervalMilliseconds
    scenarioDescription='Anonymous production login page or empty tray. No account login, model calls, session clearing or GUI automation.'
    comparisonBoundary='Comparable only when both binaries are Release, use the same production origin and are anonymous. This does not measure authenticated projects, documents, uploads, recording or voice.'
    samplingBoundary='Complete observed root/descendant process tree, including observed WebView subprocesses. Sampling may miss processes whose entire lifetime falls between samples; working-set sum includes shared pages more than once.'
    candidates=@($candidates | ForEach-Object {
        $assembly = [IO.Path]::ChangeExtension($_.Path, '.dll')
        @{label=$_.Label;path=$_.Path;version=(Get-Item -LiteralPath $_.Path).VersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $_.Path -Algorithm SHA256).Hash;managedAssemblySha256=if(Test-Path -LiteralPath $assembly){(Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash}else{$null};arguments=@($_.Arguments);isolation=$_.Isolation}
    })
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputPath 'manifest.json') -Encoding utf8NoBOM
foreach ($candidate in $candidates) {
    $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $candidate.Path })
    if ($running.Count) { throw "Candidate is already running: $($candidate.Path). Existing process was not touched." }
    foreach ($scenarioName in $scenarios) {
        for ($trial = 1; $trial -le $Trials; $trial++) {
            $arguments = @($candidate.Arguments)
            if ($scenarioName -eq 'Tray') { $arguments += '--tray' }
            $startInfo = [Diagnostics.ProcessStartInfo]::new($candidate.Path)
            $startInfo.WorkingDirectory = Split-Path -Parent $candidate.Path
            $startInfo.UseShellExecute = $false
            foreach ($argument in $arguments) { $startInfo.ArgumentList.Add($argument) }
            $timer = [Diagnostics.Stopwatch]::StartNew()
            $launched = [Diagnostics.Process]::Start($startInfo)
            $known = [Collections.Generic.HashSet[int]]::new(); [void]$known.Add($launched.Id)
            $identities = @{}; $cpuPrevious = @{}; $trialSamples = [Collections.Generic.List[object]]::new()
            $inputIdleMilliseconds = $null
            try {
                if ($scenarioName -eq 'LoginForeground') {
                    try { if ($launched.WaitForInputIdle(15000)) { $inputIdleMilliseconds = $timer.Elapsed.TotalMilliseconds } } catch [InvalidOperationException] { }
                }
                $remainingWarmup = $WarmupSeconds - $timer.Elapsed.TotalSeconds
                if ($remainingWarmup -gt 0) { Start-Sleep -Milliseconds ([int]($remainingWarmup * 1000)) }
                if ($launched.HasExited) { throw "Benchmark root exited early ($($launched.ExitCode)); single-instance handoff or failed startup invalidates this trial." }
                $sampleTimer = [Diagnostics.Stopwatch]::StartNew(); $previousSeconds = 0.0; $sampleIndex = 0
                while ($sampleTimer.Elapsed.TotalSeconds -lt $SampleSeconds) {
                    if ($launched.HasExited) { throw "Benchmark root exited during sampling ($($launched.ExitCode)); trial is invalid." }
                    $inventory = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name)
                    Expand-ProcessTree $inventory $known
                    $sampleSecondsNow = $sampleTimer.Elapsed.TotalSeconds
                    [long]$privateBytes = 0; [long]$workingSet = 0; [double]$cpuDelta = 0; $count = 0
                    foreach ($entry in $inventory | Where-Object { $known.Contains([int]$_.ProcessId) }) {
                        $processId = [int]$entry.ProcessId
                        $identity = "$processId/$($entry.CreationDate.ToUniversalTime().Ticks)"
                        if ($identities.ContainsKey($processId) -and $identities[$processId] -ne $identity) { [void]$known.Remove($processId); continue }
                        $identities[$processId] = $identity
                        try {
                            $process = Get-Process -Id $processId -ErrorAction Stop
                            $cpu = $process.TotalProcessorTime.TotalSeconds
                            if ($cpuPrevious.ContainsKey($identity)) { $cpuDelta += [Math]::Max(0, $cpu - $cpuPrevious[$identity]) }
                            elseif ($sampleIndex -gt 0 -and $entry.CreationDate.ToUniversalTime() -ge [DateTime]::UtcNow.AddSeconds(-($sampleSecondsNow-$previousSeconds)-2)) { $cpuDelta += $cpu }
                            $cpuPrevious[$identity] = $cpu
                            $privateBytes += $process.PrivateMemorySize64; $workingSet += $process.WorkingSet64; $count++
                            $processSamples.Add([pscustomobject]@{label=$candidate.Label;scenario=$scenarioName;trial=$trial;sample=$sampleIndex;elapsedSeconds=$sampleSecondsNow;processId=$processId;parentProcessId=$entry.ParentProcessId;creationUtc=$entry.CreationDate.ToUniversalTime().ToString('O');name=$entry.Name;privateBytes=$process.PrivateMemorySize64;workingSetBytes=$process.WorkingSet64;cpuSeconds=$cpu})
                            $process.Dispose()
                        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
                    }
                    $interval = $sampleSecondsNow - $previousSeconds
                    $cpuPercent = if ($sampleIndex -gt 0 -and $interval -gt 0) { 100 * $cpuDelta / $interval / $logicalProcessors } else { $null }
                    $sample = [pscustomobject]@{label=$candidate.Label;scenario=$scenarioName;trial=$trial;sample=$sampleIndex;elapsedSeconds=$sampleSecondsNow;processCount=$count;privateBytes=$privateBytes;workingSetBytes=$workingSet;cpuPercentMachine=$cpuPercent;cpuPercentOneCore=if($null -eq $cpuPercent){$null}else{$cpuPercent*$logicalProcessors}}
                    $allSamples.Add($sample); $trialSamples.Add($sample)
                    $previousSeconds = $sampleSecondsNow; $sampleIndex++
                    Start-Sleep -Milliseconds $IntervalMilliseconds
                }
                $result = [pscustomobject]@{label=$candidate.Label;scenario=$scenarioName;trial=$trial;inputIdleMilliseconds=$inputIdleMilliseconds;samples=$trialSamples.Count;medianPrivateMiB=(Get-Median @($trialSamples | ForEach-Object {$_.privateBytes/1MB}));peakPrivateMiB=($trialSamples | Measure-Object privateBytes -Maximum).Maximum/1MB;medianWorkingSetMiB=(Get-Median @($trialSamples | ForEach-Object {$_.workingSetBytes/1MB}));medianCpuPercentMachine=(Get-Median @($trialSamples.cpuPercentMachine))}
                $trialResults.Add($result)
                Write-Output ($result | ConvertTo-Json -Compress)
            } finally {
                # Exact launched root and previously observed descendants only; no name-based process killing.
                $inventory = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name)
                Expand-ProcessTree $inventory $known
                foreach ($entry in $inventory | Where-Object {$known.Contains([int]$_.ProcessId)} | Sort-Object ProcessId -Descending) {
                    $processId = [int]$entry.ProcessId
                    $identity = "$processId/$($entry.CreationDate.ToUniversalTime().Ticks)"
                    if ($identities.ContainsKey($processId) -and $identities[$processId] -ne $identity) { continue }
                    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                }
                $launched.Dispose()
                $allSamples | Export-Csv -LiteralPath (Join-Path $outputPath 'raw-samples.csv') -NoTypeInformation -Encoding utf8NoBOM
                $processSamples | Export-Csv -LiteralPath (Join-Path $outputPath 'process-samples.csv') -NoTypeInformation -Encoding utf8NoBOM
                $trialResults | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputPath 'trials.json') -Encoding utf8NoBOM
            }
        }
    }
}
$summary = @($trialResults | Group-Object label,scenario | ForEach-Object {
    [pscustomobject]@{label=$_.Group[0].label;scenario=$_.Group[0].scenario;trials=$_.Count;medianPrivateMiB=(Get-Median @($_.Group.medianPrivateMiB));medianWorkingSetMiB=(Get-Median @($_.Group.medianWorkingSetMiB));medianCpuPercentMachine=(Get-Median @($_.Group.medianCpuPercentMachine));medianInputIdleMilliseconds=(Get-Median @($_.Group.inputIdleMilliseconds))}
})
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputPath 'summary.json') -Encoding utf8NoBOM
Write-Output "Raw process samples and results: $outputPath"
