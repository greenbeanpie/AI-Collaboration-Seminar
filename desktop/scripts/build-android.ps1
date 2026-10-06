param(
  [string]$SdkRoot = 'D:\Android\Sdk',
  [string]$JavaRoot = 'C:\Program Files\Android\Android Studio\jbr',
  [string]$SigningDirectory,
  [ValidateSet('aarch64','x86_64')][string[]]$Targets = @('aarch64','x86_64'),
  [switch]$Debug,
  [switch]$Smoke
)
$ErrorActionPreference = 'Stop'
if ($Smoke -and !$Debug) { throw 'Smoke fixture requires -Debug; production APK never permits loopback fixture.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (!$SigningDirectory) { $SigningDirectory = Join-Path $repo '.local-secrets/android-signing' }
& (Join-Path $PSScriptRoot 'check-android.ps1') -SdkRoot $SdkRoot -JavaRoot $JavaRoot
$environmentNames = @('PATH','JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','NDK_HOME','ANDROID_NDK_HOME','BUWEI_DESKTOP_DEV_ORIGIN','TAURI_CONFIG')
$previous = @{}
foreach ($name in $environmentNames) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$JavaRoot\bin;$SdkRoot\platform-tools;$env:PATH"
  $env:JAVA_HOME = $JavaRoot
  $env:ANDROID_HOME = $SdkRoot
  $env:ANDROID_SDK_ROOT = $SdkRoot
  $env:NDK_HOME = "$SdkRoot\ndk\30.0.16248370"
  $env:ANDROID_NDK_HOME = $env:NDK_HOME
  if ($Smoke) {
    $env:BUWEI_DESKTOP_DEV_ORIGIN = '1'
    $env:TAURI_CONFIG = @{ app = @{ security = @{ capabilities = @(@{ identifier='main-smoke'; description='Debug loopback fixture only'; windows=@('main'); remote=@{urls=@('http://127.0.0.1:5173/*')}; local=$false; permissions=@('desktop-commands') }) } } } | ConvertTo-Json -Depth 10 -Compress
  }
  if (!(Test-Path -LiteralPath $SigningDirectory)) { New-Item -ItemType Directory -Path $SigningDirectory | Out-Null }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $SigningDirectory /inheritance:r /grant:r "${user}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE) { throw 'Cannot restrict signing directory access' }
  $keystore = Join-Path $SigningDirectory 'buwei-android.p12'
  $passwordFile = Join-Path $SigningDirectory 'store-password.txt'
  if (!(Test-Path -LiteralPath $keystore)) {
    if (Test-Path -LiteralPath $passwordFile) { throw 'Existing signing password without key; recover key before building.' }
    $random = [byte[]]::new(48)
    [Security.Cryptography.RandomNumberGenerator]::Fill($random)
    [IO.File]::WriteAllText($passwordFile,[Convert]::ToBase64String($random))
    & "$JavaRoot\bin\keytool.exe" -genkeypair -alias buwei -keystore $keystore -storetype PKCS12 -storepass:file $passwordFile -keypass:file $passwordFile -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Buwei Android Release, OU=Client, O=Buwei' | Out-Null
    if ($LASTEXITCODE) { throw 'Key generation failed' }
  }
  if (!(Test-Path -LiteralPath $passwordFile)) { throw 'Signing password missing; recover it before building.' }
  & (Join-Path $PSScriptRoot 'build-native-android.ps1') -Targets $Targets -Debug:$Debug
  $mode = if ($Debug) { 'debug' } else { 'release' }
  $output = Join-Path $repo 'output/android-client'
  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $version = (Get-Content (Join-Path $repo 'desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
  $reports = @()
  foreach ($target in $Targets) {
    $arch = if ($target -eq 'aarch64') { 'arm64' } else { 'x86_64' }
    $abi = if ($target -eq 'aarch64') { 'arm64-v8a' } else { 'x86_64' }
    $apk = Get-ChildItem (Join-Path $repo "desktop/src-tauri/gen/android/app/build/outputs/apk/$arch/$mode") -Filter '*.apk' | Select-Object -First 1
    if (!$apk) { throw "Missing built APK for $abi" }
    $destination = Join-Path $output "buwei-$version-$abi-$mode.apk"
    $aligned = Join-Path $output "$abi-aligned.tmp.apk"
    & "$SdkRoot\build-tools\37.0.0\zipalign.exe" -P 16 -f 4 $apk.FullName $aligned
    if ($LASTEXITCODE) { throw 'APK alignment failed' }
    & "$SdkRoot\build-tools\37.0.0\apksigner.bat" sign --ks $keystore --ks-key-alias buwei --ks-pass "file:$passwordFile" --key-pass "file:$passwordFile" --out $destination $aligned
    if ($LASTEXITCODE) { throw 'APK signing failed' }
    Remove-Item -LiteralPath $aligned
    $certificate = & "$SdkRoot\build-tools\37.0.0\apksigner.bat" verify --verbose --print-certs $destination
    if ($LASTEXITCODE) { throw 'APK signature verification failed' }
    $certificate | Set-Content "$destination.signature.txt"
    $reports += [pscustomobject]@{ ABI=$abi; Path=$destination; Bytes=(Get-Item $destination).Length; SHA256=(Get-FileHash $destination -Algorithm SHA256).Hash }
  }
  $reports | ConvertTo-Json | Set-Content (Join-Path $output 'artifacts.json') -Encoding utf8
  $reports | Format-Table
} finally {
  foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
}
