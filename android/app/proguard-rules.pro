# Retrofit / Gson: keep the DTO shapes the API contract depends on.
-keepattributes Signature, InnerClasses, EnclosingMethod, *Annotation*
-keep class com.cortoba.fieldops.core.network.dto.** { *; }
-keep class com.cortoba.fieldops.data.local.** { *; }
-dontwarn okhttp3.**
-dontwarn retrofit2.**
-dontwarn javax.annotation.**

# Tink (pulled in by androidx.security-crypto) references Error Prone annotations
# that are compile-time only and absent from the runtime classpath. Without these
# the release build fails in R8, not at runtime.
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.api.client.http.**
-dontwarn com.google.crypto.tink.**
-dontwarn org.joda.time.**

# Tink loads its primitives reflectively by class name.
-keep class com.google.crypto.tink.** { *; }
