const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// 设置「关于」里的本版更新：发版只写 .github/release-notes.md，这里把原文带进包里，由 releaseNotes.ts 解析
process.env.EXPO_PUBLIC_RELEASE_NOTES = fs.readFileSync(path.join(__dirname, ".github/release-notes.md"), "utf8");

// 生产打包会把 EXPO_PUBLIC_* 的值直接写进代码，但 Metro 缓存键里没有环境变量：
// 换了采集器地址再打包，会原样复用上次的旧地址。把这些值并进 cacheVersion，值一变缓存就作废。
const publicEnv = Object.keys(process.env).filter((key) => key.startsWith("EXPO_PUBLIC_")).sort()
  .map((key) => `${key}=${process.env[key]}`);
config.cacheVersion = [config.cacheVersion, ...publicEnv].join("|");

module.exports = config;
