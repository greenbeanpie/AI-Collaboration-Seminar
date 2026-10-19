[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PublishDirectory,
    [string]$AssetsFile = (Join-Path $PSScriptRoot '../App/obj/project.assets.json'),
    [switch]$Strict
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$publish = [IO.Path]::GetFullPath($PublishDirectory)
if (-not (Test-Path -LiteralPath $publish -PathType Container)) { throw "Publish directory does not exist: $publish" }
if (-not (Test-Path -LiteralPath $AssetsFile -PathType Leaf)) { throw "Run App restore first; assets missing: $AssetsFile" }
$assets = Get-Content -LiteralPath $AssetsFile -Raw | ConvertFrom-Json -AsHashtable
$cacheRoots = @($assets.packageFolders.Keys)
$directory = Join-Path $publish 'licenses'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $publish 'LICENSE') -Force
$publishedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath $publish -Recurse -File | Where-Object { -not $_.FullName.StartsWith($directory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [void]$publishedNames.Add($_.Name) }
$snapshots = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'licenses/provenance.json') -Raw | ConvertFrom-Json -AsHashtable)
$records = [Collections.Generic.List[object]]::new()
$missing = [Collections.Generic.List[string]]::new()
$targetNames = @($assets.targets.Keys | Where-Object { $_ -match '/win-x64$' })
if ($targetNames.Count -eq 0) { $targetNames = @($assets.targets.Keys) }
$targetLibraries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($target in $targetNames) { foreach ($key in $assets.targets[$target].Keys) { [void]$targetLibraries.Add($key) } }
# Self-contained framework packs are downloaded separately, outside assets.libraries.
# Use exact restore versions and evidence in publish output; never select the newest cache folder.
$runtimePacks = @{}
$runtimeMarkers = @{'Microsoft.NETCore.App.Runtime.win-x64'='coreclr.dll'; 'Microsoft.WindowsDesktop.App.Runtime.win-x64'='PresentationFramework.dll'; 'Microsoft.AspNetCore.App.Runtime.win-x64'='Microsoft.AspNetCore.dll'}
function AddRuntimePack([string]$name, [string]$version, [string]$evidence) {
    $key = "$name/$version"
    if ($runtimePacks.ContainsKey($key)) { return }
    $runtimePacks[$key] = @{marker=$runtimeMarkers[$name];evidence=$evidence}
    $assets.libraries[$key] = @{type='package';path=($name.ToLowerInvariant()+'/'+$version);files=@('LICENSE.TXT','THIRD-PARTY-NOTICES.TXT');sha512=''}
    [void]$targetLibraries.Add($key)
}
foreach ($framework in $assets.project.frameworks.Values) {
    foreach ($dependency in $framework.downloadDependencies) {
        if (-not $runtimeMarkers.ContainsKey($dependency.name) -or -not $publishedNames.Contains($runtimeMarkers[$dependency.name])) { continue }
        if ($dependency.version -notmatch '^\[([^,\]]+)(?:,\s*([^\]]+))?\]$') { throw "Runtime pack version is not exact: $($dependency.name) $($dependency.version)" }
        $version=$Matches[1].Trim(); $upper=$Matches[2]
        if ($upper -and $upper.Trim() -ne $version) { throw "Runtime pack has unresolved version range: $($dependency.name)" }
        AddRuntimePack $dependency.name $version 'assets.project.frameworks.downloadDependencies + published runtime marker'
    }
}
if ($publishedNames.Contains('coreclr.dll') -and -not @($runtimePacks.Keys | Where-Object { $_ -like 'Microsoft.NETCore.App.Runtime.win-x64/*' }).Count) {
    $coreclr=Get-ChildItem -LiteralPath $publish -Filter coreclr.dll -File -Recurse | Select-Object -First 1
    $product=[Diagnostics.FileVersionInfo]::GetVersionInfo($coreclr.FullName).ProductVersion
    if ($product -match '^(\d+\.\d+\.\d+)(?:\+|$)') { AddRuntimePack 'Microsoft.NETCore.App.Runtime.win-x64' $Matches[1] 'published coreclr.dll ProductVersion' }
    else { $missing.Add('Published coreclr.dll found but exact runtime pack version cannot be identified') }
}
function MetadataText($metadata, [string]$name) { $node = $metadata.SelectSingleNode("*[local-name()='$name']"); if ($node) { return $node.InnerText }; return '' }
foreach ($key in @($assets.libraries.Keys | Sort-Object)) {
    $library = $assets.libraries[$key]
    if ($library.type -ne 'package' -or -not $targetLibraries.Contains($key)) { continue }
    $parts = $key.Split('/'); $id = $parts[0]; $version = $parts[1]
    if ($id -notmatch '^[A-Za-z0-9_.-]+$' -or $version -notmatch '^[A-Za-z0-9_.+-]+$') { throw "Invalid package identity: $key" }
    $cache = $null
    foreach ($base in $cacheRoots) { $candidate = Join-Path $base $library.path; if (Test-Path -LiteralPath $candidate -PathType Container) { $cache = [IO.Path]::GetFullPath($candidate); break } }
    $record = [ordered]@{ package=$id; version=$version; license=''; licenseType=''; copyright=''; authors=''; projectUrl=''; repository=''; source=''; nugetSha512=$library.sha512; publishedAssets=@(); scope='restored/build-only-or-not-published'; files=@(); missing=@() }
    foreach ($target in $targetNames) {
        $entry = $assets.targets[$target][$key]
        if (-not $entry) { continue }
        foreach ($kind in @('runtime','native','runtimeTargets','resources')) {
            if (-not $entry.ContainsKey($kind)) { continue }
            foreach ($asset in $entry[$kind].Keys) { if ($publishedNames.Contains([IO.Path]::GetFileName($asset))) { $record.publishedAssets += $asset } }
        }
    }
    $record.publishedAssets = @($record.publishedAssets | Sort-Object -Unique)
    if ($record.publishedAssets.Count -gt 0) { $record.scope = 'matched-published-runtime-assets' }
    if ($runtimePacks.ContainsKey($key)) { $record.scope='self-contained-framework-runtime-pack'; $record.publishedAssets=@($runtimePacks[$key].marker); $record.discovery=$runtimePacks[$key].evidence }
    if (-not $cache) { $record.missing += 'NuGet cache directory'; $missing.Add("$key cache missing"); $records.Add($record); continue }
    if ($runtimePacks.ContainsKey($key)) {
        $hash=Get-ChildItem -LiteralPath $cache -Filter '*.nupkg.sha512' -File | Select-Object -First 1
        if ($hash) { $record.nugetSha512=(Get-Content -LiteralPath $hash.FullName -Raw).Trim() }
    }
    $destination = Join-Path $directory ($id + '/' + $version); New-Item -ItemType Directory -Force -Path $destination | Out-Null
    $nuspec = Get-ChildItem -LiteralPath $cache -Filter '*.nuspec' -File | Select-Object -First 1
    if (-not $nuspec) { $record.missing += 'nuspec'; $missing.Add("$key nuspec missing"); $records.Add($record); continue }
    $settings = [Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($nuspec.FullName, $settings)
    try { $xml = [Xml.XmlDocument]::new(); $xml.XmlResolver = $null; $xml.Load($reader) } finally { $reader.Dispose() }
    $metadata = $xml.SelectSingleNode("/*[local-name()='package']/*[local-name()='metadata']")
    $license = $metadata.SelectSingleNode("*[local-name()='license']")
    if ($license) { $record.license = $license.InnerText; $record.licenseType = $license.GetAttribute('type') }
    else { $record.license = MetadataText $metadata 'licenseUrl'; $record.licenseType = 'legacy-url-only' }
    $record.copyright = MetadataText $metadata 'copyright'; $record.authors = MetadataText $metadata 'authors'; $record.projectUrl = MetadataText $metadata 'projectUrl'
    $repository = $metadata.SelectSingleNode("*[local-name()='repository']"); if ($repository) { $record.repository = $repository.GetAttribute('url') }
    $packageMetadata = Join-Path $cache '.nupkg.metadata'
    if (Test-Path -LiteralPath $packageMetadata) {
        $feed = (Get-Content -LiteralPath $packageMetadata -Raw | ConvertFrom-Json -AsHashtable).source
        if ($feed -match '^https?://') { $safe = [UriBuilder]::new($feed); $safe.UserName=''; $safe.Password=''; $safe.Query=''; $safe.Fragment=''; $record.source=$safe.Uri.AbsoluteUri }
        elseif ($feed) { $record.source='local/private package source' }
    }
    $files = @($library.files | Where-Object { [IO.Path]::GetFileName($_) -match '(?i)^(license|copying|notice|third.?party.?notices|sdk_license)(\.|$|-)' })
    if ($record.licenseType -eq 'file') { $files += $record.license }
    $files += $nuspec.Name
    $fullLicense = $false
    foreach ($relative in @($files | Sort-Object -Unique)) {
        $source = [IO.Path]::GetFullPath((Join-Path $cache $relative))
        if (-not $source.StartsWith($cache.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Package license path escaped cache: $key" }
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { $record.missing += "Declared file: $relative"; $missing.Add("$key declared license/notice file missing: $relative"); continue }
        $output = Join-Path $destination $relative; New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $output -Force
        $record.files += [IO.Path]::GetRelativePath($publish,$output).Replace('\','/')
        if (([IO.Path]::GetFileName($relative) -match '(?i)^(license|copying|sdk_license)') -or (($record.licenseType -eq 'file') -and ($relative -eq $record.license))) { $fullLicense=$true }
    }
    if (-not $fullLicense) {
        $snapshotName = if ($id -eq 'PDFsharp' -and $version -eq '6.2.4') {'PDFsharp-6.2.4'} elseif ($id -like 'SQLitePCLRaw.*' -and $version -eq '2.1.13') {'Apache-2.0'} elseif ($id -in @('Microsoft.Data.Sqlite','Microsoft.Data.Sqlite.Core','System.Security.Cryptography.Pkcs') -and $version -eq '10.0.13') {'dotnet-10.0.13'} elseif ($id -eq 'System.Security.Cryptography.ProtectedData' -and $version -eq '10.0.0') {'dotnet-10.0.0'} else {''}
        $snapshot = $snapshots | Where-Object { $_.name -eq $snapshotName } | Select-Object -First 1
        if ($snapshot) {
            $source = Join-Path $PSScriptRoot ('licenses/' + $snapshot.file)
            if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $snapshot.sha256) { throw "License snapshot hash mismatch: $snapshotName" }
            $output=Join-Path $destination 'UPSTREAM-LICENSE.txt'; Copy-Item -LiteralPath $source -Destination $output -Force
            $record.files += [IO.Path]::GetRelativePath($publish,$output).Replace('\','/'); $record.licenseSnapshotSource=$snapshot.url; $fullLicense=$true
        }
    }
    if (-not $fullLicense) { $record.missing += 'Full license text unavailable locally'; $missing.Add("$key full license text missing ($($record.scope)); declaration: $($record.license)") }
    if (-not $record.license) { $record.missing += 'License declaration'; $missing.Add("$key license declaration missing") }
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'package-info.json') -Encoding utf8
    $records.Add($record)
}
$manifest=[ordered]@{ formatVersion=1; projectLicense='GPL-3.0 (see LICENSE)'; targets=$targetNames; inventoryScope='Selected restored dependency graph; matched published runtime assets are labelled; build-only metadata retained without binaries.'; packages=$records.ToArray(); missing=$missing.ToArray(); fonts='Windows installed fonts are not redistributed as application files. Export embeds only permitted subsets.' }
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $publish 'THIRD-PARTY-NOTICES.json') -Encoding utf8
$lines=[Collections.Generic.List[string]]::new(); $lines.Add('Third-party dependency notices'); $lines.Add('Project: GNU GPL version 3; see LICENSE. Package original license/notice files are under licenses/.'); $lines.Add('Inventory includes restored build dependencies separately from files matched in publish output. No package binaries or fonts are copied by this script.'); $lines.Add('')
foreach ($record in $records) { $lines.Add("$($record.package) $($record.version) | $($record.licenseType): $($record.license) | $($record.scope)"); $lines.Add("Authors: $($record.authors); Copyright: $($record.copyright)"); $lines.Add("Source: $($record.source); Repository: $($record.repository)"); foreach ($file in $record.files) { $lines.Add("  $file") }; foreach ($item in $record.missing) { $lines.Add("  MISSING: $item") }; $lines.Add('') }
$lines | Set-Content -LiteralPath (Join-Path $publish 'THIRD-PARTY-NOTICES.txt') -Encoding utf8
foreach ($item in $missing) { Write-Warning "License collection: $item" }
Write-Output "Collected $($records.Count) package notices; $($missing.Count) missing items. Output: $publish"
if ($Strict -and $missing.Count -gt 0) { throw "License collection incomplete: $($missing.Count) missing items; see THIRD-PARTY-NOTICES.json" }
