param(
  [string]$AdbPath = 'D:\Android\Sdk\platform-tools\adb.exe',
  [string]$Package = 'cn.buwei.mobile',
  [ValidateSet('foreground','background')][string]$Label = 'foreground',
  [ValidateRange(3,60)][int]$Seconds = 10
)
$ErrorActionPreference = 'Stop'
if ($Package -notmatch '^[a-z][a-z0-9_.]+$') { throw 'Invalid package identifier' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $repo 'output/android'
New-Item -ItemType Directory -Force $output | Out-Null
$androidPid = (& $AdbPath shell pidof $Package).Trim().Split(' ')[0]
if (!$androidPid) { throw 'Start the app before measuring.' }
$ticks = [int](& $AdbPath shell getconf CLK_TCK)
function Get-CpuTicks {
  $raw = (& $AdbPath shell cat "/proc/$androidPid/stat") -join ''
  if ($LASTEXITCODE -ne 0) { throw 'Android does not permit process CPU measurement.' }
  $fields = $raw.Substring($raw.LastIndexOf(')') + 2).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
  return [long]$fields[11] + [long]$fields[12]
}
$first = Get-CpuTicks
$clock = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$last = Get-CpuTicks
$clock.Stop()
$memory = & $AdbPath shell dumpsys meminfo $Package
$memory | Set-Content (Join-Path $output "$Label-meminfo.txt")
$values = (($memory -join "`n") | Select-String 'TOTAL PSS:\s+(\d+)\s+TOTAL RSS:\s+(\d+)').Matches
$report = [ordered]@{
  Timestamp = [DateTime]::UtcNow.ToString('o'); Package = $Package; PID = $androidPid; Label = $Label
  SampleSeconds = $clock.Elapsed.TotalSeconds
  CPUPercentOfOneCore = [Math]::Round(100 * ($last - $first) / $ticks / $clock.Elapsed.TotalSeconds, 3)
  PSSKiB = if ($values.Count) { [long]$values[0].Groups[1].Value } else { $null }
  RSSKiB = if ($values.Count) { [long]$values[0].Groups[2].Value } else { $null }
  Boundary = 'App host process only; excludes isolated WebView renderer and BlueStacks host. Synthetic emulator measurement, not a phone benchmark.'
}
$report | ConvertTo-Json | Set-Content (Join-Path $output "$Label-resources.json")
$report | ConvertTo-Json
