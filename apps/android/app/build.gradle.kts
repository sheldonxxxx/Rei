import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val firebaseConfigured = file("src/firebase/assets/rei-firebase.json").isFile
val firebaseIncluded = firebaseConfigured || providers.gradleProperty("reiCompileFirebase").orNull == "true"

// Release identity and the in-app update feed come from Gradle properties (-P on the command line or gradle.properties).
// An empty reiUpdateFeedUrl turns update checks off, so a fork signed with another key never offers this project's builds.
val reiVersionCode = providers.gradleProperty("reiVersionCode").orNull?.let {
    it.toIntOrNull()?.takeIf { code -> code > 0 } ?: error("reiVersionCode must be a positive integer, got \"$it\".")
} ?: 1
val reiVersionName = providers.gradleProperty("reiVersionName").orNull ?: "0.1.0"
val reiUpdateFeedUrl = providers.gradleProperty("reiUpdateFeedUrl").orNull.orEmpty().trim()

android {
    namespace = "dev.rei.android"
    compileSdk {
        version = release(37) { minorApiLevel = 1 }
    }

    defaultConfig {
        applicationId = "dev.rei.android"
        minSdk = 28
        targetSdk = 37
        versionCode = reiVersionCode
        versionName = reiVersionName
        buildConfigField("String", "UPDATE_FEED_URL", "\"${reiUpdateFeedUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        manifestPlaceholders["reiFirebaseEnabled"] = firebaseIncluded.toString()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets.named("main") {
        kotlin.directories += if (firebaseIncluded) "src/firebase/java" else "src/noFirebase/java"
        if (firebaseConfigured) assets.directories += "src/firebase/assets"
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    if (firebaseIncluded) implementation("com.google.firebase:firebase-messaging:24.1.2")

    implementation(platform("androidx.compose:compose-bom:2026.11.01"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3.adaptive:adaptive:1.2.0")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.core:core-splashscreen:1.2.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.navigation:navigation-compose:2.10.2")
    implementation("androidx.browser:browser:1.10.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("org.commonmark:commonmark:0.33.0")
    implementation("org.commonmark:commonmark-ext-autolink:0.33.0")
    implementation("org.commonmark:commonmark-ext-gfm-strikethrough:0.33.0")
    implementation("org.commonmark:commonmark-ext-gfm-tables:0.33.0")
    implementation("org.commonmark:commonmark-ext-task-list-items:0.33.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:5.5.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.11.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Package the same offline Office and PDF renderers used by the web client. viewer/build.mjs writes into
// build/generated/documentViewer/viewer/, so the files land under assets/viewer/ in the APK.
abstract class BuildDocumentViewer @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:Internal
    abstract val viewerDir: DirectoryProperty
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val inputFiles: ConfigurableFileCollection
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun build() {
        exec.exec {
            workingDir(viewerDir)
            commandLine("node", "build.mjs")
        }
    }
}

val buildDocumentViewer = tasks.register<BuildDocumentViewer>("buildDocumentViewer") {
    val web = rootProject.file("../web")
    viewerDir.set(rootProject.file("viewer"))
    inputFiles.from(
        rootProject.file("viewer"),
        web.resolve("src"),
        web.resolve("vite.config.ts"),
        rootProject.file("../../package-lock.json"),
    )
    outputDir.set(layout.buildDirectory.dir("generated/documentViewer"))
}

// Package the pinned Mermaid build (the web client's locked npm dependency) and its licence for offline diagrams,
// under assets/mermaid/.
abstract class BundleMermaid @Inject constructor(private val fs: FileSystemOperations) : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val localAssets: DirectoryProperty
    @get:Internal
    abstract val mermaidPackage: DirectoryProperty
    // The npm files actually copied, so a Mermaid update reruns the task. Optional so a missing package reaches the check below.
    @get:InputFiles
    @get:Optional
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val packageFiles: ConfigurableFileCollection
    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun bundle() {
        val mermaid = mermaidPackage.get().asFile
        check(mermaid.resolve("dist/mermaid.min.js").isFile) { "Mermaid is missing: run npm ci in the repository root." }
        fs.sync {
            into(outputDir.dir("mermaid"))
            from(localAssets)
            from(mermaid.resolve("dist/mermaid.min.js"))
            from(mermaid.resolve("LICENSE")) { rename { "LICENSE-mermaid.txt" } }
        }
    }
}

val bundleMermaid = tasks.register<BundleMermaid>("bundleMermaid") {
    localAssets.set(rootProject.file("mermaid"))
    mermaidPackage.set(rootProject.file("../../node_modules/mermaid"))
    packageFiles.from(mermaidPackage.file("dist/mermaid.min.js"), mermaidPackage.file("LICENSE"))
    outputDir.set(layout.buildDirectory.dir("generated/mermaid"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(buildDocumentViewer, BuildDocumentViewer::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(bundleMermaid, BundleMermaid::outputDir)
    }
}
