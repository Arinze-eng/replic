// ── Repositories ────────────────────────────────────────────────────────────
// IMPORTANT: settings.gradle.kts uses RepositoriesMode.PREFER_PROJECT (NOT
// FAIL_ON_PROJECT_REPOS) because the Flutter Gradle plugin injects its own
// project-level `maven` repository (download.flutter.io) — FAIL_ON_PROJECT_REPOS
// rejects that and breaks `flutter-gradle-plugin` application.
//
// Because PREFER_PROJECT makes project-level repositories authoritative, the
// :app module resolves its (transitive) releaseRuntimeClasspath using THIS
// list. It must therefore include JitPack, or the transitive
// com.github.TeamNewPipe:NewPipeExtractor (via :spotuiengine -> :innertube) and
// com.github.bumptech.glide:compose fail to resolve.
allprojects {
    repositories {
        google()
        mavenCentral()
        maven { url = uri("https://jitpack.io") }
        maven { url = uri("https://storage.googleapis.com/download.flutter.io") }
    }
}

val newBuildDir: Directory = rootProject.layout.buildDirectory.dir("../../build").get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}

// Disable lint for all subprojects (lint is flaky on plugin modules).
subprojects {
    tasks.matching { it.name.contains("lint", ignoreCase = true) }.configureEach {
        enabled = false
    }
}
