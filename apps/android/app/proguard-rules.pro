# Rei Android R8 rules. R8 full mode is on, so anything reached only by reflection or by the manifest needs a rule.

# Components named in AndroidManifest.xml are kept by AGP's generated rules. These are explicit so a rename of either
# cannot silently drop it from a release build. ReiFirebaseService only exists when Firebase is compiled in.
-keep class dev.rei.android.ReiFirebaseService { *; }
-keep class dev.rei.android.update.UpdateInstallReceiver { *; }
-dontwarn com.google.firebase.**

# kotlinx.serialization looks up the generated serializer of a class through its Companion and $$serializer.
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisibleAnnotations
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclassmembers class **$$serializer { *; }
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}

# androidx.credentials loads its Play services provider by class name.
-keep class androidx.credentials.** { *; }
-keep class androidx.credentials.playservices.** { *; }
-dontwarn androidx.credentials.**

# OkHttp 5 optionally uses these TLS providers when installed. They are not bundled.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
