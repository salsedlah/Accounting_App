import java.net.URI

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val releaseKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
val productionApiBaseUrl = System.getenv("HISAB_API_BASE_URL")
val releaseSigningConfigured = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "com.hisab.hisab_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.hisab.hisab_mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("production") {
            if (releaseSigningConfigured) {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            val releaseRequested = gradle.startParameter.taskNames.any {
                it.contains("release", ignoreCase = true)
            }
            if (releaseRequested) {
                val apiUri = productionApiBaseUrl?.trim()?.let { value ->
                    runCatching { URI(value) }.getOrNull()
                }
                val apiHost = apiUri?.host?.lowercase().orEmpty()
                val privateIpv4 = apiHost.matches(Regex("^(10\\.|127\\.|192\\.168\\.|169\\.254\\.).*")) ||
                    Regex("^172\\.(1[6-9]|2[0-9]|3[01])\\..*").matches(apiHost)
                if (apiUri?.scheme != "https" || apiHost.isBlank() || apiHost == "localhost" ||
                    apiHost.endsWith(".local") || privateIpv4 || apiUri.userInfo != null ||
                    apiUri.query != null || apiUri.fragment != null) {
                    throw GradleException(
                        "A public HTTPS HISAB_API_BASE_URL is required for production builds.",
                    )
                }
                if (!releaseSigningConfigured) {
                    throw GradleException(
                        "Production signing is not configured. Set ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD.",
                    )
                }
                signingConfig = signingConfigs.getByName("production")
            } else if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("production")
            }
        }
    }
}

flutter {
    source = "../.."
}

