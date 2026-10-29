import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { bundleAndroidStories } from "./android-story.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, CI: "1" };
if (!env.JAVA_HOME && existsSync("/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home")) {
  env.JAVA_HOME = "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
}
if (!env.ANDROID_HOME) {
  env.ANDROID_HOME = [env.ANDROID_SDK_ROOT, path.join(process.env.HOME ?? "", "Library/Android/sdk"), "/opt/homebrew/share/android-commandlinetools"]
    .find(value => value && existsSync(path.join(value, "platform-tools")));
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 退出码：${result.status ?? 1}`);
}

// Expo updates the iOS command even for --platform android. Preserve that unrelated setting.
const packageFile = path.join(root, "package.json");
const originalIosScript = JSON.parse(readFileSync(packageFile, "utf8")).scripts.ios;
try {
  run(process.execPath, ["node_modules/expo/bin/cli", "prebuild", "--platform", "android", "--no-install", "--no-clean", "--skip-dependency-update", "react-native,react"]);
} finally {
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  if (originalIosScript === "expo start --ios" && pkg.scripts.ios === "expo run:ios") {
    pkg.scripts.ios = originalIosScript;
    writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}
bundleAndroidStories(root);
if (process.argv.includes("--prebuild-only")) process.exit(0);
if (!env.ANDROID_HOME) throw new Error("请设置 ANDROID_HOME，指向安装好的 Android SDK。");
run(process.platform === "win32" ? "gradlew.bat" : "./gradlew", ["assembleRelease", "--no-daemon", "--max-workers=1", "--no-parallel", "--init-script", path.join(root, "scripts/android-proof.gradle"), "-Pkotlin.compiler.execution.strategy=in-process", "-PreactNativeArchitectures=arm64-v8a"], path.join(root, "android"));
const output = path.join(root, "release", "DouyinDataReview-Android-arm64.apk");
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(path.join(root, "android/app/build/outputs/apk/release/app-release.apk"), output);
console.log(`\nAndroid APK（开发签名，ARM64）：${output}`);
