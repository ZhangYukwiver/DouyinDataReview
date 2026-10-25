// 剪映素材的预览图：剪映把打开过的素材面板（转场、滤镜、字体、动画……）的接口响应缓存在
// User Data/Cache/ressdk_db/<账号>/rp.db 的 http_cache 表里，每条素材带 cover_url（字节图床的签名地址，约一年过期）。
// 这里只读这份缓存、不联网：在剪映里没打开过的面板就没有图，页面照旧只显示名字。
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

const CACHE_PARTS = ["JianyingPro", "User Data", "Cache", "ressdk_db"];

/** 剪映资源缓存目录：Mac 在 ~/Movies 下，Windows 在 %LOCALAPPDATA% 下。 */
export function ressdkRoot({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "win32") return env?.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, ...CACHE_PARTS) : null;
  if (platform === "darwin") return path.join(home, "Movies", ...CACHE_PARTS);
  return null;
}

function databases(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "rp.db"));
  } catch {
    return [];
  }
}

const mtime = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };

// 素材对象里 effect_id 在前、cover_url 紧跟在后（中间没有嵌套对象）。整段 JSON.parse 两个库要一秒多，正则只要零点一秒，
// 抠到的和完整解析一样（10-23 本机 Mac 剪映 11.6 对过：目录 4541 条里都是 1427 条有图）
const COVER = /"effect_id":"(\d+)"[^{}]*?"cover_url":(\{[^{}]*\})/gu;

// 动画类的 small 是整段 GIF（三五百 KB，一栏一百多张），static_img 是第一帧 PNG（几十 KB）：平时显示静态图，GIF 留给鼠标移上去时播
function coverOf(text) {
  try {
    const { small, static_img: still } = JSON.parse(text);
    const cover = still || small;
    if (typeof cover !== "string" || !cover.startsWith("https:")) return null;
    return typeof small === "string" && small.startsWith("https:") && small !== cover ? { cover, preview: small } : { cover };
  } catch {
    return null;
  }
}

async function readDatabase(file, covers) {
  // node:sqlite 是 Node 22.5+ 的内置模块（Electron 43 带的是 24）；没有就当没缓存
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // 采集器在 Electron 主进程里跑：一行一行读，每行之间让出去，别一口气卡住界面（最大的一行六七兆）
    for (const { response_body: body } of db.prepare("SELECT response_body FROM http_cache").iterate()) {
      if (typeof body !== "string") continue;
      for (const [, id, text] of body.matchAll(COVER)) {
        const found = coverOf(text);
        if (found) covers.set(id, found);
      }
      await nextTurn();
    }
  } finally {
    db.close();
  }
}

/**
 * 按剪映资源 id 找预览图地址。剪映在用时库文件会变（WAL），每次查先比一下修改时间，变了才重读（本机两个库共 60MB，一两秒）。
 * 第一次要等读完；之后有变化就先用上一份、后台重读，读好了下次查就是新的。
 * ponytail: 只认默认缓存位置；用户在剪映里改了缓存路径就读不到，要支持再从 globalSetting 的 currentCachePath 找。
 */
export function createCoverIndex({ root = ressdkRoot() } = {}) {
  let stamp = null;
  let covers = new Map();
  let loading = null;
  const reload = (files, next) => {
    loading ??= (async () => {
      const fresh = new Map();
      for (const file of files) {
        // 剪映正写着时偶尔读不了，这份库先跳过，下次再读
        try { await readDatabase(file, fresh); } catch { /* 读不了的库跳过 */ }
      }
      stamp = next;
      covers = fresh;
    })().finally(() => { loading = null; });
    return loading;
  };
  return {
    /** 拿一份当前的对照表：(资源 id) → { cover: 静态图, preview?: 动图 } */
    async lookup() {
      const files = root ? databases(root) : [];
      const next = files.map((file) => `${file}:${mtime(file)}:${mtime(`${file}-wal`)}`).join("|");
      if (stamp === null) await reload(files, next);
      else if (next !== stamp) void reload(files, next);
      const map = covers;
      return (meta) => map.get(String(meta?.resource_id ?? "")) ?? map.get(String(meta?.effect_id ?? "")) ?? null;
    },
  };
}
