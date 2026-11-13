import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const isFile = async (file) => {
  try { return (await stat(file)).isFile(); } catch { return false; }
};

/** 只找 WorkBuddy 桌面版自带的 CLI，避免把另行安装的 CodeBuddy 当成同一个账号。 */
export async function findWorkbuddyCli({ platform, env, home, run }) {
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const listed = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const roots = [
    env.DY2_WORKBUDDY_PATH,
    ...listed.map((dir) => path.join(dir, platform === "win32" ? "WorkBuddy.exe" : "workbuddy")),
    ...(platform === "darwin" ? ["/Applications/WorkBuddy.app", path.join(home, "Applications", "WorkBuddy.app")] : []),
    ...(platform === "win32" ? [path.join(local, "Programs", "WorkBuddy"), path.join(local, "WorkBuddy"),
      ...[env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map((dir) => path.join(dir, "WorkBuddy"))] : []),
    ...(platform === "linux" ? ["/opt/WorkBuddy", "/opt/workbuddy", "/usr/lib/workbuddy", path.join(home, ".local", "share", "WorkBuddy")] : []),
  ].filter(Boolean);

  const resolve = async (candidate) => {
    let root;
    try {
      root = await realpath(candidate);
      // 环境变量也可以直接指向 .exe 或 app 内的 CLI；软链接按真实安装目录识别。
      if ((await stat(root)).isFile()) {
        if (path.basename(root) === "codebuddy" && path.basename(path.dirname(root)) === "bin") {
          root = path.resolve(root, "..", "..", "..", "..", "..", ...(platform === "darwin" ? [".."] : []));
        } else if (platform === "darwin" && path.basename(path.dirname(root)) === "MacOS") {
          root = path.resolve(root, "..", "..", "..");
        } else root = path.dirname(root);
      }
    } catch { return null; }
    const resources = platform === "darwin" ? path.join(root, "Contents", "Resources") : path.join(root, "resources");
    const cli = path.join(resources, "app.asar.unpacked", "cli");
    const entry = path.join(cli, "bin", "codebuddy");
    const product = path.join(cli, "product.json");
    if (!await isFile(entry) || !await isFile(product)) return null;
    try {
      if (JSON.parse(await readFile(product, "utf8")).productName !== "WorkBuddy") return null;
    } catch { return null; }
    const lite = await isFile(path.join(cli, "dist", "codebuddy-lite-wb.mjs")) || await isFile(path.join(cli, "dist", "codebuddy-lite-wb.js"));
    if (!lite && !await isFile(path.join(cli, "dist", "codebuddy-headless.js")) && !await isFile(path.join(cli, "dist", "codebuddy.js"))) return null;
    const executable = platform === "darwin" ? path.join(root, "Contents", "MacOS", "WorkBuddy")
      : path.join(root, platform === "win32" ? "WorkBuddy.exe" : "workbuddy");
    // 用桌面版自己的 Node，避免本应用的 Electron 和 WorkBuddy 原生模块版本不匹配。
    if (!await isFile(executable)) return null;
    const configDir = env.WORKBUDDY_CONFIG_DIR || path.join(home, ".workbuddy");
    let version = "";
    try {
      const manifest = JSON.parse(await readFile(path.join(resources, "install-manifest.json"), "utf8"));
      if (typeof manifest.appVersion === "string" && /^\d+\.\d+\.\d+(?:[.+-][\w.-]+)?$/u.test(manifest.appVersion)) version = manifest.appVersion;
    } catch { /* 较早的安装包没有清单；CLI 仍可使用自己的版本信息。 */ }
    return {
      command: executable, prefix: [entry], path: entry,
      workbuddy: { configDir },
      env: {
        ELECTRON_RUN_AS_NODE: "1", CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
        ...(lite ? { CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1" } : {}),
        CODEBUDDY_CONFIG_DIR: configDir, WORKBUDDY_CONFIG_DIR: configDir,
        ACC_PRODUCT_CONFIG_PATH: product,
        CODEBUDDY_HOST: "workbuddy-desktop", CLIENT_INFO_PLATFORM: "WorkBuddy",
        CLIENT_INFO_IDE_TYPE: "WorkBuddy", CLIENT_INFO_PRODUCT_NAME: "WorkBuddy", CLIENT_INFO_PLUGIN_NAME: "workbuddy-desktop",
        ...(version ? { CLIENT_INFO_PRODUCT_VERSION: version, CLIENT_INFO_PLUGIN_VERSION: version } : {}),
      },
    };
  };
  for (const root of new Set(roots)) {
    const found = await resolve(root);
    if (found) return found;
  }
  // Windows 自定义安装位置：只查 WorkBuddy 注册的启动命令，不扫描磁盘。
  if (platform === "win32" && run) {
    const registered = await Promise.all([
      "HKCU\\Software\\Classes\\workbuddy\\shell\\open\\command",
      "HKLM\\Software\\Classes\\workbuddy\\shell\\open\\command",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe",
    ].map(async (key) => {
      try {
        const result = await run("reg.exe", ["query", key, "/ve"], { env, timeoutMs: 3_000 });
        if (result.code !== 0) return null;
        const value = result.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/u)?.[1]?.trim();
        return value?.match(/^"([^"]+\.exe)"/iu)?.[1] ?? value?.match(/^(.+?WorkBuddy\.exe)(?:\s|$)/iu)?.[1];
      } catch { return null; }
    }));
    for (const candidate of registered.filter(Boolean)) {
      const expanded = candidate.replace(/%([^%]+)%/gu, (match, key) => env[key] ?? match);
      const found = await resolve(expanded);
      if (found) return found;
    }
  }
  return null;
}

export const WORKBUDDY_REQUIRED_FLAGS = ["--input-format", "--output-format", "--include-partial-messages", "--tools",
  "--setting-sources", "--strict-mcp-config", "--permission-mode", "--system-prompt-file", "--no-session-persistence", "--max-turns"];

/** 和桌面端同一份登录存储；不读取、复制或解密其令牌。 */
export function workbuddyEnv() {
  return {
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CODEBUDDY_SKIP_GIT_BASH_CHECK: "1",
    CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_AUTO_MEMORY: "1",
    CODEBUDDY_MEMORY_RELEVANCE_DISABLED: "1", CODEBUDDY_MEMORY_EXTRACTION_DISABLED: "1",
    CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1", CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CODEBUDDY_DISABLE_PRODUCT_CACHE: "1", CODEBUDDY_DISABLE_CRON: "1", CODEBUDDY_DISABLE_PLUGIN_INSTALLS: "1",
    CODEBUDDY_GIT_REPO_SCAN_DISABLED: "1", CODEBUDDY_DISABLE_IDE: "1",
  };
}
