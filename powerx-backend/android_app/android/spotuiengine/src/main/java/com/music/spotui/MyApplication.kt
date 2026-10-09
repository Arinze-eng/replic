package com.music.spotui

import android.app.Application
import com.metrolist.innertube.YouTube
import com.metrolist.innertube.models.YouTubeLocale
import com.metrolist.music.utils.cipher.CipherDeobfuscator
import com.music.spotui.data.api.Api
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Spotui runtime bootstrap.
 *
 * Originally this was the app's `@HiltAndroidApp Application`. Since Spotui now
 * ships as the "WormGPT Ultra" library module INSIDE the WormGPT Flutter host,
 * the host owns the single Hilt `Application`. This object keeps the exact same
 * one-time initialisation (Spotify/Canvas loggers, YouTube cipher + PoToken,
 * locale/visitorData, home-feed warm-up) and exposes `instance` (the app
 * Context) that Spotui singletons rely on. The host Application calls
 * [MyApplication.init] from its own onCreate.
 */
object MyApplication {

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // For non-DI singletons (LyricsApi, CurrentSongState) that need a Context.
    @JvmStatic
    lateinit var instance: Application
        private set

    @Volatile
    private var initialised = false

    @JvmStatic
    fun init(app: Application) {
        if (initialised) return
        initialised = true
        instance = app

        // Surface Spotify REST/GQL logs to logcat for diagnosis.
        com.metrolist.spotify.Spotify.logger = { level, msg ->
            android.util.Log.d("SpotifyREST", "[$level] $msg")
        }
        com.metrolist.spotify.SpotifyCanvas.setLogger { level, msg ->
            android.util.Log.d("SpotifyCanvas", "[$level] $msg")
        }
        // Required by the ported YouTube streaming flow (cipher/PoToken WebViews).
        CipherDeobfuscator.initialize(app)

        // Locale + visitorData must be set or the player can't mint a PoToken,
        // and googlevideo rejects the stream URL with HTTP 403 (tracks stuck at 0:00).
        val locale = Locale.getDefault()
        YouTube.locale = YouTubeLocale(
            gl = locale.country.takeIf { it.isNotBlank() } ?: "US",
            hl = locale.language.takeIf { it.isNotBlank() } ?: "en",
        )
        appScope.launch {
            YouTube.visitorData = YouTube.visitorData().getOrNull() ?: YouTube.visitorData
        }
        // YouTube playback runs anonymously; age-gated official audio falls back
        // to matching normal YouTube uploads instead of requiring sign-in.
        YouTube.cookie = null

        // Warm the Home feed cache so the first navigation to Home is instant.
        // No-op (gracefully) until a Spotify token is available.
        val api = Api(app)
        appScope.launch { runCatching { api.getHomeFeed().collect {} } }
        appScope.launch { runCatching { api.getAlbums().collect {} } }
        appScope.launch { runCatching { api.getArtists().collect {} } }
    }
}
