param([string[]]$Targets=@('aarch64','x86_64'),[switch]$Debug)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$tauri=Join-Path $repo 'desktop/src-tauri'
$project=Join-Path $tauri 'gen/android'
$ndkbin=Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$mode=if($Debug){'debug'}else{'release'}
$names=@('TAURI_ANDROID_PROJECT_PATH','TARGET_AR','TARGET_CC','TARGET_CXX','ANDROID_NATIVE_API_LEVEL','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER','CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS','CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER','CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS')
$previous=@{}
foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
  $env:TAURI_ANDROID_PROJECT_PATH=$project
  $env:TARGET_AR=Join-Path $ndkbin 'llvm-ar.exe'
  $env:ANDROID_NATIVE_API_LEVEL='26'
  $config=Get-Content (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json
  $v=$config.version.Split('.')
  $versionCode=[int]$v[0]*1000000+[int]$v[1]*10000+[int]$v[2]*1000
  "tauri.android.versionName=$($config.version)`ntauri.android.versionCode=$versionCode" | Set-Content (Join-Path $project 'app/tauri.properties') -Encoding ascii
  $gradleTasks=@()
  $skipTasks=@()
  foreach($target in $Targets){
    $triple="$target-linux-android"
    $key=$triple.Replace('-','_').ToUpperInvariant()
    $compiler=Join-Path $ndkbin "$($triple)26-clang.cmd"
    $env:TARGET_CC=$compiler
    $env:TARGET_CXX=Join-Path $ndkbin "$($triple)26-clang++.cmd"
    [Environment]::SetEnvironmentVariable("CARGO_TARGET_${key}_LINKER",$compiler,'Process')
    [Environment]::SetEnvironmentVariable("CARGO_TARGET_${key}_RUSTFLAGS",'-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES','Process')
    $cargoArgs=@('build','--locked','--lib','--manifest-path',(Join-Path $tauri 'Cargo.toml'),'--target',$triple)
    if(!$Debug){$cargoArgs+='--release'}
    & cargo @cargoArgs
    if($LASTEXITCODE){throw "Rust Android build failed for $triple"}
    $abi=if($target -eq 'aarch64'){'arm64-v8a'}else{'x86_64'}
    $flavor=if($target -eq 'aarch64'){'Arm64'}else{'X86_64'}
    $nativeDirectory=Join-Path $project "app/src/main/jniLibs/$abi"
    New-Item -ItemType Directory $nativeDirectory -Force | Out-Null
    $library=Join-Path $tauri "target/$triple/$mode/libbuwei_desktop_core.so"
    Copy-Item -LiteralPath $library -Destination $nativeDirectory -Force
    $dependencies=& (Join-Path $ndkbin 'llvm-readelf.exe') -d $library
    if($LASTEXITCODE){throw 'Cannot inspect native dependencies'}
    if($dependencies -match 'libc\+\+_shared.so'){
      Copy-Item -LiteralPath (Join-Path $ndkbin "../sysroot/usr/lib/$triple/libc++_shared.so") -Destination $nativeDirectory -Force
    }
    $profile=if($Debug){'Debug'}else{'Release'}
    $gradleTasks+="assemble$flavor$profile"
    $skipTasks+=@('-x',"rustBuild$flavor$profile")
  }
  Push-Location $project
  try {
    & ./gradlew.bat @gradleTasks @skipTasks --no-daemon --no-configuration-cache
    if($LASTEXITCODE){throw 'Gradle Android packaging failed'}
  }finally{Pop-Location}
}finally{
  foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
}
