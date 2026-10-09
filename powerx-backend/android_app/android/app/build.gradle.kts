import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // ── Bundled WormGPT Ultra (Spotui) music engine needs these on the host so
    //    the single merged APK carries Compose + Hilt + KSP-generated code. ──
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("com.google.dagger.hilt.android")
}

// ── Stable release signing ──────────────────────────────────────────────
// Loads the persistent release keystore so EVERY build (local + CI) is signed
// with the SAME key, keeping installs/updates consistent forever.
// Resolution order:
//   1. android/key.properties file (written by CI from secrets, or locally)
//   2. environment variables (KEYSTORE_PATH / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD)
// If neither is present (e.g. a contributor with no key), it falls back to the
// debug signing config so the build never breaks.
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasKeystoreFile = keystorePropertiesFile.exists()
if (hasKeystoreFile) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

fun signingValue(propKey: String, envKey: String): String? =
    (keystoreProperties.getProperty(propKey) ?: System.getenv(envKey))?.takeIf { it.isNotBlank() }

val releaseStoreFile = signingValue("storeFile", "KEYSTORE_PATH")
val releaseStorePassword = signingValue("storePassword", "KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "KEY_PASSWORD")
val hasReleaseSigning = releaseStoreFile != null && releaseStorePassword != null &&
    releaseKeyAlias != null && releaseKeyPassword != null

android {
    namespace = "com.hackerx.wormgpt_agent"
    compileSdk = 35
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    buildFeatures {
        // The Spotui music screens are Jetpack Compose; the host launches them.
        compose = true
    }

    defaultConfig {
        applicationId = "com.hackerx.wormgpt_agent"
        // Bumped 21 → 26 to match the bundled Spotui music engine (media3 media
        // session + WebView Spotify player require API 26+).
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        // Persistent release key — used for every release build when the
        // keystore credentials are available (CI secrets or key.properties).
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    // PRoot is shipped as libproot.so so Android accepts it as a native ABI
    // payload, but it is launched as an executable. Force extraction to
    // applicationInfo.nativeLibraryDir on every supported Android version.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    // ── Lint ────────────────────────────────────────────────────────────────
    // Disable the release "lint vital" pass. It runs a full analysis on the
    // release variant and was OOM-ing the CI runner (java.lang.OutOfMemoryError:
    // Metaspace in :app:lintVitalAnalyzeRelease) after the heavy Spotui/Compose/
    // media3 deps were added. It is not required to produce the APK.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

flutter {
    source = "../.."
}

dependencies {
    // 🔥 WormGPT Ultra — bundled native Spotui music engine (real Spotify login,
    // streaming, downloads, lyrics, canvas). Launched from the Tools grid.
    implementation(project(":spotuiengine"))

    // ── Jetpack Compose runtime on the :app classpath ───────────────────────
    // :app enables `buildFeatures { compose = true }` and applies the Compose
    // compiler plugin (it launches Spotui's Compose screens). The Compose
    // compiler plugin REQUIRES the Compose Runtime to be on this module's
    // classpath, otherwise compileReleaseKotlin fails with
    // IncompatibleComposeRuntimeVersionException. Bring in the same Compose BOM
    // the :spotuiengine library uses so versions stay aligned.
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.0")

    // Hilt runtime (the app is the @HiltAndroidApp root for Spotui's injections).
    implementation("com.google.dagger:hilt-android:2.57.1")
    ksp("com.google.dagger:hilt-android-compiler:2.57.1")

    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
