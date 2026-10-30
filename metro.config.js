const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Android APK packaging shares memory with Gradle and the native compiler.
if (process.argv.includes("export:embed") && process.argv.includes("android")) {
  config.maxWorkers = 2;
}

// 设置「关于」里的近 5 版更新：发版只写 .github/release-notes.md（只有这一版），前几版从发版标签里取当时的同一个文件。
// 没有 git 或标签（源码压缩包、浅克隆）就只有这一版。原文拼在一起带进包里，由 releaseNotes.ts 解析、去重、取前 5 版
const RELEASE_NOTES_FILE = ".github/release-notes.md";
const git = (...args) => execFileSync("git", args, { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
let pastReleaseNotes = [];
try {
  pastReleaseNotes = git("tag", "--list", "v*", "--merged", "HEAD", "--sort=-v:refname").split("\n").filter(Boolean).slice(0, 5)
    .map((tag) => git("show", `${tag}:${RELEASE_NOTES_FILE}`));
} catch {}
process.env.EXPO_PUBLIC_RELEASE_NOTES = [fs.readFileSync(path.join(__dirname, RELEASE_NOTES_FILE), "utf8"), ...pastReleaseNotes].join("\n\n");

// 生产打包会把 EXPO_PUBLIC_* 的值直接写进代码，但 Metro 缓存键里没有环境变量：
// 换了采集器地址再打包，会原样复用上次的旧地址。把这些值并进 cacheVersion，值一变缓存就作废。
const publicEnv = Object.keys(process.env).filter((key) => key.startsWith("EXPO_PUBLIC_")).sort()
  .map((key) => `${key}=${process.env[key]}`);
config.cacheVersion = [config.cacheVersion, ...publicEnv].join("|");

module.exports = config;
