import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// 浏览器扩展「推荐流过滤」装在 userData 下一个固定的文件夹里，浏览器从这里加载，扩展发现应用带了新版本会自己重新加载。

export function extensionVersion(directory) {
  try {
    const version = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

// 扩展的版本号是点分数字（1.2.0）
export function isNewerVersion(candidate, current) {
  const a = String(candidate).split(".").map(Number);
  const b = String(current).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

// 还没拷过或应用带的版本更新才覆盖，不然一个字节都不动（浏览器可能正开着它）。覆盖时原地写文件、删掉新版没有的旧文件，
// 不先清空整个文件夹。返回覆盖后文件夹里的版本
export function syncFeedExtension(source, target) {
  const installed = extensionVersion(target);
  if (installed && !isNewerVersion(extensionVersion(source), installed)) return installed;
  const shipped = (name) => !name.endsWith(".test.mjs");
  cpSync(source, target, { recursive: true, force: true, filter: (file) => shipped(path.basename(file)) });
  const keep = new Set(readdirSync(source).filter(shipped));
  for (const name of readdirSync(target)) if (!keep.has(name)) rmSync(path.join(target, name), { recursive: true, force: true });
  return extensionVersion(target);
}
