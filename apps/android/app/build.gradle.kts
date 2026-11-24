import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
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

    buildTypes {
        release {
            // R8 full mode is the AGP 9 default. Keep rules for reflection-reached code live in proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // The signed dependency-metadata block is only useful to Play and just fingerprints the build.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
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
    if (firebaseIncluded) implementation(libs.firebase.messaging)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material3.adaptive)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services.auth)
    implementation(libs.commonmark)
    implementation(libs.commonmark.ext.autolink)
    implementation(libs.commonmark.ext.gfm.strikethrough)
    implementation(libs.commonmark.ext.gfm.tables)
    implementation(libs.commonmark.ext.task.list.items)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
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
