plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "com.cortoba.fieldops"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cortoba.fieldops"
        minSdk = 26
        targetSdk = 35
        versionCode = 13
        versionName = "1.0.13"
        // The Render service URL. Overridable per build so a staging build does
        // not need a source edit.
        buildConfigField(
            "String",
            "API_BASE_URL",
            "\"${project.findProperty("cortobaApiBaseUrl") ?: "https://cortoba-rfq.onrender.com"}\"",
        )
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    /**
     * A committed, shared signing key.
     *
     * Android refuses to install an update whose signature differs from the
     * installed app (INSTALL_FAILED_UPDATE_INCOMPATIBLE). A CI runner starts with
     * an empty ~/.android, so the auto-generated debug key was DIFFERENT on every
     * run: each release was signed by a new certificate and could never be
     * installed over the previous one. The representative kept running the old
     * build, which is why fixed code appeared to change nothing.
     *
     * This key is a debug-only key with the public password "android" — the same
     * security model as the AOSP debug keystore, which is also shipped in the
     * clear. It exists so builds are reproducible, NOT to protect a release. A
     * production key must be supplied through CI secrets and never committed.
     */
    signingConfigs {
        create("fieldOpsDebug") {
            storeFile = file("keystore/fieldops-debug.jks")
            storePassword = "android"
            keyAlias = "cortoba"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with the same key as debug so an APK the representative
            // already has can be updated in place. Swap for a CI-secret release
            // key before publishing to a store.
            signingConfig = signingConfigs.getByName("fieldOpsDebug")
        }
        debug {
            applicationIdSuffix = ".debug"
            signingConfig = signingConfigs.getByName("fieldOpsDebug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests {
            // Robolectric needs the real merged resources to inflate the theme
            // and resolve @font/@drawable references, which is exactly where a
            // launch crash hides.
            isIncludeAndroidResources = true
        }
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)
    // WorkManager workers are constructed by Hilt, so the worker itself is
    // injected: hilt-work provides @HiltWorker and its compiler the factory glue.
    implementation(libs.hilt.work)
    ksp(libs.hilt.compiler.androidx)

    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)

    implementation(libs.kotlinx.coroutines.android)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.runner)
    testImplementation(libs.androidx.test.ext.junit)
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}
