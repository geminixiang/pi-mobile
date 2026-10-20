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

# Capacitor finds plugins and their methods by reflection (@CapacitorPlugin, @PluginMethod).
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * { @com.getcapacitor.PluginMethod public *; }
-keep class com.getcapacitor.** { *; }
# SQLCipher (used by @capacitor-community/sqlite) loads its classes from native code.
-keep class net.zetetic.** { *; }
-dontwarn net.zetetic.**
# Compile-time annotations referenced by Tink (androidx.security via secure storage); absent at runtime.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# sshlib (SshPlugin) finds its ciphers, MACs, key exchanges, and its Ed25519 provider by class name.
-keep class com.trilead.ssh2.** { *; }
-dontwarn com.trilead.ssh2.**
