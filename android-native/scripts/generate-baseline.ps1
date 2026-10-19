param(
  [string]$Serial='emulator-5556',
  [string]$SdkRoot='D:/Android/Sdk',
  [string]$JavaRoot='C:/Program Files/Android/Android Studio/jbr'
)
$ErrorActionPreference='Stop'
if($Serial -notmatch '^[A-Za-z0-9_.:-]+$'){throw 'Invalid device serial'}
$project=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$adb=Join-Path $SdkRoot 'platform-tools/adb.exe'
$previous=@{};foreach($name in @('JAVA_HOME','ANDROID_HOME')){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
function Invoke-Adb([string[]]$Arguments){
  $result=& $adb -s $Serial @Arguments 2>&1
  if($LASTEXITCODE){throw ($result -join "`n")}
  return ($result -join "`n")
}
try {
  $env:JAVA_HOME=$JavaRoot;$env:ANDROID_HOME=$SdkRoot
  & (Join-Path $project 'gradlew.bat') -p $project :app:assembleNonMinifiedRelease :baselineprofile:assembleNonMinifiedRelease --console=plain
  if($LASTEXITCODE){throw 'Profile APK build failed'}
  # Uses the preview package only; never uninstalls, clears data, or resets credentials.
  Invoke-Adb @('install','-r',(Join-Path $project 'app/build/outputs/apk/nonMinifiedRelease/app-nonMinifiedRelease.apk'))|Write-Output
  Invoke-Adb @('install','-r',(Join-Path $project 'baselineprofile/build/outputs/apk/nonMinifiedRelease/baselineprofile-nonMinifiedRelease.apk'))|Write-Output
  $result=Invoke-Adb @('shell','am','instrument','-w','-r','-e','androidx.benchmark.enabledRules','BaselineProfile','cn.buwei.nativeapp.baselineprofile/androidx.test.runner.AndroidJUnitRunner')
  $output=Join-Path $project '../output/android-native';New-Item -ItemType Directory -Force $output|Out-Null
  $result|Set-Content (Join-Path $output 'baseline-profile-instrumentation.txt')
  if($result -notmatch 'OK \(1 test\)' -or $result -match 'FAILURES!!!'){throw 'Profile collection failed; inspect instrumentation output'}
  # Explicit short destinations avoid adb's Windows MAX_PATH failure inside AGP's
  # connected_android_test_additional_output directory. Do not hide empty-profile warnings.
  $destination=Join-Path $project 'app/src/release/generated/baselineProfiles'
  New-Item -ItemType Directory -Force $destination|Out-Null
  $profile=Join-Path $destination 'startup-prof.txt'
  Invoke-Adb @('pull','/sdcard/Android/media/cn.buwei.nativeapp.baselineprofile/StartupProfile_loginStartup-startup-prof.txt',$profile)|Write-Output
  if(!(Test-Path $profile) -or (Get-Item $profile).Length -eq 0){throw 'Profile rules are empty'}
  Copy-Item -LiteralPath $profile -Destination (Join-Path $destination 'baseline-prof.txt') -Force
  Write-Output 'Collected unauthenticated startup rules; rebuild Release to package them. Business paths are not profiled.'
} finally {foreach($name in $previous.Keys){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}}
