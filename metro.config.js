const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// 生产打包会把 EXPO_PUBLIC_* 的值直接写进代码，但 Metro 缓存键里没有环境变量：
// 换了采集器地址再打包，会原样复用上次的旧地址。把这些值并进 cacheVersion，值一变缓存就作废。
const publicEnv = Object.keys(process.env).filter((key) => key.startsWith("EXPO_PUBLIC_")).sort()
  .map((key) => `${key}=${process.env[key]}`);
config.cacheVersion = [config.cacheVersion, ...publicEnv].join("|");

module.exports = config;
