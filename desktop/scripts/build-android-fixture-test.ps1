param([string]$SdkRoot='D:\Android\Sdk',[string]$JavaRoot='C:\Program Files\Android\Android Studio\jbr',[string]$SigningDirectory)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if(!$SigningDirectory){$SigningDirectory=Join-Path $repo '.local-secrets/android-signing'}
$names=@('JAVA_HOME','ANDROID_HOME','PATH')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
    $env:JAVA_HOME=$JavaRoot
    $env:ANDROID_HOME=$SdkRoot
    $env:PATH="$JavaRoot\bin;$env:PATH"
    Push-Location (Join-Path $repo 'desktop/src-tauri/gen/android')
    try{ & ./gradlew.bat assembleX86_64DebugAndroidTest -x rustBuildX86_64Debug --no-daemon --no-configuration-cache; if($LASTEXITCODE){throw 'Instrumentation APK build failed'} }finally{Pop-Location}
    $apk=Get-ChildItem (Join-Path $repo 'desktop/src-tauri/gen/android/app/build/outputs/apk/androidTest/x86_64/debug') -Filter '*.apk' | Select-Object -First 1
    if(!$apk){throw 'Instrumentation APK missing'}
    $output=Join-Path $repo 'output/android-client'
    New-Item -ItemType Directory $output -Force | Out-Null
    $aligned=Join-Path $output 'fixture-test-aligned.tmp.apk'
    $destination=Join-Path $output 'buwei-fixture-test.apk'
    & "$SdkRoot\build-tools\37.0.0\zipalign.exe" -P 16 -f 4 $apk.FullName $aligned
    if($LASTEXITCODE){throw 'Instrumentation alignment failed'}
    & "$JavaRoot\bin\java.exe" --enable-native-access=ALL-UNNAMED -jar "$SdkRoot\build-tools\37.0.0\lib\apksigner.jar" sign --ks (Join-Path $SigningDirectory 'buwei-android.p12') --ks-key-alias buwei --ks-pass ('file:'+(Join-Path $SigningDirectory 'store-password.txt')) --out $destination $aligned
    if($LASTEXITCODE){throw 'Instrumentation signing failed'}
    & "$JavaRoot\bin\java.exe" --enable-native-access=ALL-UNNAMED -jar "$SdkRoot\build-tools\37.0.0\lib\apksigner.jar" verify --verbose --print-certs $destination
    if($LASTEXITCODE){throw 'Instrumentation verification failed'}
    Remove-Item -LiteralPath $aligned
    Write-Output $destination
}finally{foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}}
