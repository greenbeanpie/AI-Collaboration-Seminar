param(
  [string]$SdkRoot='D:/Android/Sdk',
  [string]$JavaRoot='C:/Program Files/Android/Android Studio/jbr',
  [string]$SigningDirectory,
  [switch]$Debug,
  [switch]$SkipChecks
)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$project=Join-Path $repo 'android-native'
$names=@('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT')
$previous=@{};foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
  $env:JAVA_HOME=$JavaRoot;$env:ANDROID_HOME=$SdkRoot;$env:ANDROID_SDK_ROOT=$SdkRoot
  foreach($required in @("$JavaRoot/bin/java.exe","$SdkRoot/platforms/android-37.0/android.jar","$SdkRoot/build-tools/37.0.0/zipalign.exe")){if(!(Test-Path -LiteralPath $required)){throw "Missing tool: $required"}}
  $tasks=@();if(!$SkipChecks){$tasks+=@(':app:testDebugUnitTest',':app:lintDebug')}
  $mode=if($Debug){'debug'}else{'release'}
  $tasks+=if($Debug){':app:assembleDebug'}else{':app:assembleRelease'}
  & (Join-Path $project 'gradlew.bat') -p $project @tasks --console=plain
  if($LASTEXITCODE){throw 'Native Android build/checks failed'}
  $output=Join-Path $repo 'output/android-native';New-Item -ItemType Directory -Force $output|Out-Null
  $apk=Get-ChildItem (Join-Path $project "app/build/outputs/apk/$mode") -Filter '*.apk'|Select-Object -First 1
  if(!$apk){throw 'APK was not generated'}
  $apkMetadata=Get-Content -LiteralPath (Join-Path $apk.DirectoryName 'output-metadata.json') -Raw | ConvertFrom-Json
  $version=$apkMetadata.elements[0].versionName
  if($version -notmatch '^[A-Za-z0-9._-]+$'){throw 'APK version metadata is invalid'}
  $destination=Join-Path $output "buwei-native-$version-$mode.apk"
  if($Debug){Copy-Item -LiteralPath $apk.FullName -Destination $destination -Force}
  else {
    if(!$SigningDirectory){throw 'Release requires explicit -SigningDirectory pointing to an existing key; no replacement key is generated.'}
    $keystore=Join-Path $SigningDirectory 'buwei-android.p12';$password=Join-Path $SigningDirectory 'store-password.txt'
    if(!(Test-Path -LiteralPath $keystore) -or !(Test-Path -LiteralPath $password)){throw 'Existing signing key/password not found'}
    $aligned=Join-Path $output 'native-aligned.tmp.apk'
    & "$SdkRoot/build-tools/37.0.0/zipalign.exe" -P 16 -f 4 $apk.FullName $aligned
    if($LASTEXITCODE){throw 'APK alignment failed'}
    & "$JavaRoot/bin/java.exe" --enable-native-access=ALL-UNNAMED -jar "$SdkRoot/build-tools/37.0.0/lib/apksigner.jar" sign --ks $keystore --ks-key-alias buwei --ks-pass "file:$password" --out $destination $aligned
    if($LASTEXITCODE){throw 'APK signing failed'}
    Remove-Item -LiteralPath $aligned
  }
  & "$JavaRoot/bin/java.exe" --enable-native-access=ALL-UNNAMED -jar "$SdkRoot/build-tools/37.0.0/lib/apksigner.jar" verify --verbose --print-certs $destination | Set-Content "$destination.signature.txt"
  if($LASTEXITCODE){throw 'APK signature verification failed'}
  [ordered]@{path=$destination;sourceCommit=(& git -C $repo rev-parse HEAD).Trim();sourceTreeDirty=[bool](& git -C $repo status --porcelain --untracked-files=no);versionName=$version;versionCode=$apkMetadata.elements[0].versionCode;bytes=(Get-Item $destination).Length;sha256=(Get-FileHash $destination -Algorithm SHA256).Hash;mode=$mode;applicationId=if($Debug){'cn.buwei.mobile.nativepreview.debug'}else{'cn.buwei.mobile.nativepreview'};architecture='arm64-v8a and x86_64 (managed UI; universal APK)'}|ConvertTo-Json|Set-Content (Join-Path $output "$mode-artifact.json")
  Write-Output $destination
} finally {foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}}
