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

# Release builds run R8 (minifyEnabled true in build.gradle). Keep what is reached
# by reflection or by name over JNI, which R8 cannot see.

# Capacitor finds each plugin class by its annotation and calls its @PluginMethod
# methods by reflection. The annotation has to survive as well.
-keepattributes *Annotation*
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }

# FcmStatusPlugin looks up FirebaseApp by name with Class.forName.
-keep class com.google.firebase.FirebaseApp { *; }

# SQLCipher and LiteRT are loaded with System.loadLibrary and bind Java classes by name.
-keep class net.zetetic.** { *; }
-keep class com.google.ai.edge.litertlm.** { *; }
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
