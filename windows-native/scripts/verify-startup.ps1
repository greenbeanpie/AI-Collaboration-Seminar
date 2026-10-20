param([Parameter(Mandatory)][string]$PublishDirectory, [Parameter(Mandatory)][string]$ReportPath)
$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath (Join-Path $PublishDirectory 'Buwei.Windows.Native.exe')).Path
$diagnostics = Join-Path ([IO.Path]::GetTempPath()) 'Buwei.Windows.Native.Diagnostics/startup-errors.log'
$before = if (Test-Path -LiteralPath $diagnostics) { [IO.File]::ReadAllText($diagnostics) } else { '' }
# Never interrupt an existing user's benchmark instance or reuse its settings.
$existing = Get-CimInstance Win32_Process -Filter "Name = 'Buwei.Windows.Native.exe'" | Where-Object { $_.CommandLine -match '--benchmark' }
if ($existing) { throw 'An existing benchmark instance is running; stop that instance before this isolated startup check.' }
$owned = $null
$second = $null
try {
    $owned = Start-Process -FilePath $binary -ArgumentList '--benchmark' -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $owned.Refresh()
        if ($owned.HasExited) { throw "Published app exited before creating a window: $($owned.ExitCode)" }
    } while ($owned.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($owned.MainWindowHandle -eq 0) { throw 'Published app did not create a native window within 30 seconds.' }
    $windowHandle = $owned.MainWindowHandle.ToInt64()
    Start-Sleep -Seconds 10
    $owned.Refresh()
    if ($owned.HasExited -or !$owned.Responding) { throw 'Published app did not remain alive and responsive.' }
    $second = Start-Process -FilePath $binary -ArgumentList '--benchmark' -PassThru
    if (!$second.WaitForExit(10000)) { throw 'Second launch did not forward activation and exit.' }
    if ($second.ExitCode -ne 0) { throw "Second launch failed: $($second.ExitCode)" }
    $owned.Refresh()
    if ($owned.HasExited -or !$owned.Responding) { throw 'First instance failed after activation forwarding.' }
    $after = if (Test-Path -LiteralPath $diagnostics) { [IO.File]::ReadAllText($diagnostics) } else { '' }
    if ($after -ne $before) { throw 'Native diagnostics changed during startup; inspect startup-errors.log.' }
    $report = [ordered]@{
        passed = $true; checkedAtUtc = [DateTime]::UtcNow.ToString('O'); binary = $binary
        sha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
        version = (Get-Item -LiteralPath $binary).VersionInfo.FileVersion
        processId = $owned.Id; nativeWindowHandle = $windowHandle; responsiveAfterSeconds = 10
        secondLaunchExitCode = $second.ExitCode; newStartupErrors = $false
        profile = 'Isolated benchmark profile; no account login'; visualAcceptance = $false
    }
    $reportDirectory = Split-Path ([IO.Path]::GetFullPath($ReportPath)) -Parent
    [IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
    $report | ConvertTo-Json | Set-Content -LiteralPath $ReportPath -Encoding utf8
    $report | ConvertTo-Json
} finally {
    # Only processes created by this invocation; closing the window would leave it in the tray.
    foreach ($created in @($second, $owned)) {
        if ($null -ne $created -and !$created.HasExited) { $created.Kill(); $created.WaitForExit(5000) | Out-Null }
    }
}
