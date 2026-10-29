plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("androidx.baselineprofile")
}
android {
    namespace = "cn.buwei.nativeapp"
    compileSdk = 37
    buildToolsVersion = "37.0.0"
    ndkVersion = "30.0.16248370"
    defaultConfig {
        applicationId = "cn.buwei.mobile.nativepreview"
        minSdk = 26
        targetSdk = 37
        versionCode = 8
        versionName = "0.2.6-preview"
        ndk { abiFilters += listOf("arm64-v8a","x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "SERVICE_ORIGIN", "\"https://greenbp-team-office.hddhp.workers.dev\"")
        // Public Firebase application configuration; service-account keys never enter APKs.
        buildConfigField("String", "FIREBASE_APP_ID", "\"${providers.gradleProperty("firebaseAppId").getOrElse("")}\"")
        buildConfigField("String", "FIREBASE_API_KEY", "\"${providers.gradleProperty("firebaseApiKey").getOrElse("")}\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${providers.gradleProperty("firebaseProjectId").getOrElse("")}\"")
        buildConfigField("String", "FIREBASE_SENDER_ID", "\"${providers.gradleProperty("firebaseSenderId").getOrElse("")}\"")
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; manifestPlaceholders["cleartext"] = "true" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            manifestPlaceholders["cleartext"] = "false"
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    testOptions { unitTests.isReturnDefaultValues = true }
    packaging { resources.excludes += setOf("META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/DEPENDENCIES") }
}
dependencies {
    baselineProfile(project(":baselineprofile"))
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.fragment:fragment:1.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.browser:browser:1.10.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.room:room-runtime:2.8.5")
    annotationProcessor("androidx.room:room-compiler:2.8.5")
    implementation("androidx.datastore:datastore-preferences:1.3.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.google.firebase:firebase-messaging:26.0.1")
    implementation("com.google.android.gms:play-services-base:18.11.1")
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")
    implementation("org.bouncycastle:bcpkix-jdk15to18:1.86")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.5.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    // Compose's transitive 3.5.0 uses InputManager reflection removed on recent Android.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:5.5.1")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
baselineProfile { automaticGenerationDuringBuild = false }


// README is the only authored manual. Package bounded help sections as generated assets.
abstract class GenerateHandbookAssets : DefaultTask() {
    @get:InputFile
    abstract val handbook: org.gradle.api.file.RegularFileProperty
    @get:OutputDirectory
    abstract val destination: org.gradle.api.file.DirectoryProperty
    @TaskAction
    fun generate() {
        val text = handbook.get().asFile.readText(Charsets.UTF_8).replace("\r\n", "\n")
        mapOf("user" to "USER-GUIDE.md", "technical" to "TECHNICAL-IMPLEMENTATION.md", "database" to "DATABASE-SCHEMA.md").forEach { (key, filename) ->
            val start = "<!-- help:$key:start -->\n"
            val end = "<!-- help:$key:end -->"
            require(text.split(start).size == 2 && text.split(end).size == 2) { "Invalid handbook boundaries: $key" }
            val from = text.indexOf(start) + start.length
            val to = text.indexOf(end)
            require(to > from) { "Reversed handbook boundaries: $key" }
            val content = text.substring(from, to)
            require(content.isNotBlank()) { "Empty handbook section: $key" }
            val target = destination.get().file("native-help/$filename").asFile
            target.parentFile.mkdirs()
            target.writeText(content, Charsets.UTF_8)
        }
    }
}
val generateHandbookAssets = tasks.register<GenerateHandbookAssets>("generateHandbookAssets") {
    handbook.set(rootProject.layout.projectDirectory.file("../README.md"))
    destination.set(layout.buildDirectory.dir("generated/handbook-assets"))
}
androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(generateHandbookAssets, GenerateHandbookAssets::destination)
}
tasks.withType<Test>().configureEach { dependsOn(generateHandbookAssets) }
