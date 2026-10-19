$ErrorActionPreference = 'Stop'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('Buwei.Package.Resources.Test.' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
function Reject([string]$Expected) {
    try {
        & (Join-Path $PSScriptRoot 'package.ps1') -PublishDirectory $scratch -RuntimeInstaller (Join-Path $scratch 'runtime.exe') -OutputDirectory (Join-Path $scratch 'out') | Out-Null
    } catch {
        if ($_.Exception.Message.Contains($Expected)) { Write-Output "PASS $Expected"; return }
        throw
    }
    throw "Packaging unexpectedly accepted fixture: $Expected"
}
try {
    foreach ($name in @('Buwei.Windows.Native.exe', 'coreclr.dll', 'runtime.exe')) { [IO.File]::WriteAllBytes((Join-Path $scratch $name), [byte[]]@()) }
    Reject 'Compiled native XAML resources are missing'
    [IO.File]::WriteAllBytes((Join-Path $scratch 'App.xbf'), [byte[]]@(0x58,0x42,0x46,0))
    Copy-Item -LiteralPath (Join-Path $scratch 'App.xbf') -Destination (Join-Path $scratch 'Buwei.Windows.Native.pri')
    Reject 'Native XAML resource headers are invalid'
    [IO.File]::WriteAllBytes((Join-Path $scratch 'Buwei.Windows.Native.pri'), [Text.Encoding]::ASCII.GetBytes('mrm_pri2'))
    [IO.File]::WriteAllBytes((Join-Path $scratch 'App.xbf'), [byte[]]@(0,0,0,0))
    Reject 'Native XAML resource headers are invalid'
    [IO.File]::WriteAllBytes((Join-Path $scratch 'App.xbf'), [byte[]]@(0x58,0x42,0x46,0))
    Reject 'Runtime installer must have a valid Microsoft Authenticode signature'
} finally {
    # Only remove the exact files this fixture created; no recursive directory deletion.
    foreach ($name in @('Buwei.Windows.Native.exe','coreclr.dll','runtime.exe','App.xbf','Buwei.Windows.Native.pri')) { Remove-Item -LiteralPath (Join-Path $scratch $name) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $scratch
}
