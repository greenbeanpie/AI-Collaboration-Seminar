# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# Rust JNI and Tauri plugin registration look up these classes and methods by name.
-keep class cn.buwei.mobile.NativeFilesPlugin { *; }
-keep class cn.buwei.mobile.MainActivity { *; }

# Plugin JSON serialization reflects DTO members.
-keep class cn.buwei.mobile.Session { *; }
-keep class cn.buwei.mobile.PickedFile { *; }
