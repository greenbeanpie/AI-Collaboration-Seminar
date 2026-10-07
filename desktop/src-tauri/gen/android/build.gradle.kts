buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.4.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.20")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}


// Use the already installed stable SDK for Tauri's included Android library too.
subprojects {
    afterEvaluate {
        extensions.findByType(com.android.build.api.dsl.LibraryExtension::class.java)?.apply {
            compileSdk = 37
            compileOptions.sourceCompatibility = JavaVersion.VERSION_17
            compileOptions.targetCompatibility = JavaVersion.VERSION_17
        }
        extensions.findByType(org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension::class.java)?.compilerOptions?.jvmTarget?.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}
