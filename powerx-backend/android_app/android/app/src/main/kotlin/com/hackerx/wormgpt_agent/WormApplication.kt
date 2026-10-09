package com.hackerx.wormgpt_agent

import io.flutter.app.FlutterApplication
import com.music.spotui.MyApplication
import dagger.hilt.android.HiltAndroidApp

/**
 * The single [android.app.Application] for the WormGPT Agent APK.
 *
 * It is BOTH:
 *  • the Flutter host application (extends [FlutterApplication]), and
 *  • the Hilt application root (`@HiltAndroidApp`) required by the bundled
 *    Spotui music engine (WormGPT Ultra), whose ViewModels/services are
 *    Hilt-injected.
 *
 * On startup it runs Spotui's one-time bootstrap (Spotify/YouTube engine init)
 * via [MyApplication.init] so the Ultra music screen is ready the moment the
 * user opens it from the Tools grid.
 */
@HiltAndroidApp
class WormApplication : FlutterApplication() {
    override fun onCreate() {
        super.onCreate()
        // Boot the Spotui (WormGPT Ultra) music engine. Wrapped so any failure
        // here can never block the whole app from launching.
        runCatching { MyApplication.init(this) }
    }
}
