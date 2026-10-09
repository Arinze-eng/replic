# Flutter / plugin keep rules
-keep class io.flutter.** { *; }
-keep class io.flutter.plugins.** { *; }
-keep class io.flutter.plugin.** { *; }

# flutter_secure_storage
-keep class com.it_nomads.fluttersecurestorage.** { *; }

# webview_flutter
-keep class io.flutter.plugins.webviewflutter.** { *; }

# device_info_plus / path_provider / shared_preferences — safe keeps
-keep class dev.fluttercommunity.** { *; }

# Keep annotations & generic signatures
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Suppress common warnings
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
