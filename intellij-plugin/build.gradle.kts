import java.io.File

plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "com.heaplens"
version = "0.1.0-prototype"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform { intellijIdeaCommunity("2025.1.7") }
    implementation("com.google.code.gson:gson:2.13.1")
    testImplementation("org.junit.jupiter:junit-jupiter:5.12.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // IntelliJ's test bootstrap references JUnit 4 even for Jupiter-only port tests.
    testRuntimeOnly("junit:junit:4.13.2")
}

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

intellijPlatform {
    pluginConfiguration {
        name = "HeapLens Prototype"
        ideaVersion { sinceBuild = "251"; untilBuild = "251.*" }
    }
    buildSearchableOptions = false
}

val generateWebview by tasks.registering(Exec::class) {
    workingDir(projectDir)
    commandLine("node", "scripts/build-webview.cjs")
    inputs.dir("../src/webview")
    inputs.file("../media/d3.v7.min.js")
    inputs.file("scripts/build-webview.cjs")
    inputs.dir("src/main/webview")
    outputs.dir(layout.buildDirectory.dir("generated/webview"))
}
sourceSets.main { resources.srcDir(layout.buildDirectory.dir("generated/webview")) }
tasks.processResources { dependsOn(generateWebview) }
val testWebview by tasks.registering(Exec::class) {
    dependsOn(generateWebview)
    workingDir(projectDir)
    commandLine("node", "--test", "scripts/webview.test.cjs")
}
tasks.test {
    dependsOn(testWebview)
    val ciMode = providers.systemProperty("heaplens.test.ci").orNull == "true"
    useJUnitPlatform { if (ciMode) excludeTags("local-fixture") }
    if (ciMode) {
        // CI must exercise the real process boundary, not quietly skip it.
        require(!providers.systemProperty("heaplens.test.server").orNull.isNullOrBlank()) {
            "CI requires heaplens.test.server; real-engine checks must not be skipped"
        }
        require(!providers.systemProperty("heaplens.test.dump").orNull.isNullOrBlank()) {
            "CI requires heaplens.test.dump; provide the generated fixture"
        }
        systemProperty("heaplens.test.ci", "true")
    }
    systemProperty("heaplens.test.childClasspath", sourceSets.test.get().output.classesDirs.asPath +
        File.pathSeparator + configurations.testRuntimeClasspath.get().files
            .filter { it.name.startsWith("gson-") }.joinToString(File.pathSeparator))
    // Explicit local test inputs, never an automatic scan of the user's files.
    listOf("heaplens.test.server", "heaplens.test.dump", "heaplens.test.matrix").forEach { key ->
        providers.systemProperty(key).orNull?.let { systemProperty(key, it) }
    }
    testLogging { events("passed", "skipped", "failed") }
}
tasks.runIde {
    providers.systemProperty("heaplens.server.path").orNull?.let { systemProperty("heaplens.server.path", it) }
}
