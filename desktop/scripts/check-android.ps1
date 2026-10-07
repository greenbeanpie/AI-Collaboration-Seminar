param([string]$SdkRoot = 'D:\Android\Sdk', [string]$JavaRoot = 'C:\Program Files\Android\Android Studio\jbr')
$ErrorActionPreference = 'Stop'
$required = @(
  "$SdkRoot\platform-tools\adb.exe", "$SdkRoot\platforms\android-37.0\android.jar",
  "$SdkRoot\build-tools\37.0.0\apksigner.bat", "$SdkRoot\build-tools\37.0.0\zipalign.exe",
  "$SdkRoot\ndk\30.0.16248370\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe",
  "$JavaRoot\bin\java.exe", "$JavaRoot\bin\keytool.exe", "$env:USERPROFILE\.cargo\bin\rustup.exe"
)
foreach ($path in $required) { if (!(Test-Path -LiteralPath $path)) { throw "Missing required tool: $path" } }
$targets = & "$env:USERPROFILE\.cargo\bin\rustup.exe" target list --installed
foreach ($target in @('aarch64-linux-android','x86_64-linux-android')) { if ($targets -notcontains $target) { throw "Missing Rust target: rustup target add $target" } }
& "$JavaRoot\bin\java.exe" -version
& "$SdkRoot\platform-tools\adb.exe" devices -l
Write-Output 'Android build environment verified: SDK37, BuildTools37, NDK30, ARM64 and x86_64 Rust targets.'
