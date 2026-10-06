param([Parameter(Mandatory)][int]$RootProcessId, [ValidateSet('foreground-idle','project','tray','transfer','edge-pwa')][string]$Scenario = 'foreground-idle', [int]$Seconds = 60, [string]$OutputPath = './resource-samples.csv')
$ErrorActionPreference = 'Stop'
if ($Seconds -lt 2) { throw 'At least two seconds are required' }
$samples = @()
$previousCpu = @{}
$previousTime = Get-Date
for ($sampleIndex = 0; $sampleIndex -lt $Seconds; $sampleIndex++) {
    $inventory = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    do {
        $changed = $false
        foreach ($processInfo in $inventory) {
            if ($ids.Contains([int]$processInfo.ParentProcessId) -and $ids.Add([int]$processInfo.ProcessId)) { $changed = $true }
        }
    } while ($changed)
    $now = Get-Date
    $elapsed = ($now - $previousTime).TotalSeconds
    $cpuSeconds = 0.0; $workingSet = 0L; $privateBytes = 0L; $count = 0
    foreach ($processId in $ids) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        $count++; $workingSet += $process.WorkingSet64; $privateBytes += $process.PrivateMemorySize64
        $identity = "$processId-$($process.StartTime.Ticks)"
        if ($previousCpu.ContainsKey($identity)) { $cpuSeconds += [Math]::Max(0, $process.CPU - $previousCpu[$identity]) }
        $previousCpu[$identity] = $process.CPU
    }
    $samples += [PSCustomObject]@{ TimestampUtc = $now.ToUniversalTime().ToString('o'); Scenario = $Scenario; RootProcessId = $RootProcessId; ProcessCount = $count; WorkingSetMiB = [Math]::Round($workingSet / 1MB, 2); PrivateMiB = [Math]::Round($privateBytes / 1MB, 2); CpuPercentMachine = if ($sampleIndex -eq 0) { 0 } else { [Math]::Round(100 * $cpuSeconds / $elapsed / [Environment]::ProcessorCount, 2) } }
    $previousTime = $now
    Start-Sleep -Seconds 1
}
$samples | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding utf8
$samples | Select-Object -Skip 1 | Measure-Object WorkingSetMiB, PrivateMiB, CpuPercentMachine -Average -Maximum
