#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
java_home=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
cache="$HOME/.gradle/caches/modules-2/files-2.1"
compiler=$(find "$cache/org.jetbrains.kotlin/kotlin-compiler-embeddable" -name '*.jar' | sort | tail -1)
classpath="$compiler"
for artifact in kotlin-stdlib kotlin-script-runtime kotlin-reflect kotlin-daemon-embeddable; do
    jar=$(find "$cache/org.jetbrains.kotlin/$artifact" -name '*.jar' | sort | tail -1)
    classpath="$classpath:$jar"
done
for artifact in org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm org.jetbrains/annotations; do
    jar=$(find "$cache/$artifact" -name '*.jar' | sort | tail -1)
    classpath="$classpath:$jar"
done
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
"$java_home/bin/java" -cp "$classpath" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath "$classpath" -d "$out" android/app/src/main/java/dev/geminixiang/pimobile/ScreenText.kt android/app/src/main/java/dev/geminixiang/pimobile/ScreenChanges.kt android/agentscreen/test/ScreenTextTest.kt
"$java_home/bin/java" -cp "$out:$classpath" dev.geminixiang.pimobile.ScreenTextTestKt
