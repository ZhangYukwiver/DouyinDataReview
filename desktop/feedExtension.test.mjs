import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isNewerVersion, syncFeedExtension } from "./feedExtension.mjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function extension(version, files = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "feed-extension-"));
  directories.push(directory);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version }));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
  return directory;
}

describe("推荐流过滤扩展的拷贝", () => {
  it("比版本号按数字比", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.2.1", "1.2")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.2.0")).toBe(false);
  });

  it("还没拷过就整份拷过去，不带单测文件", async () => {
    const source = await extension("1.2.0", { "page.js": "new", "filter.test.mjs": "test" });
    const target = path.join(await extension("0"), "browser-extension");
    expect(syncFeedExtension(source, target)).toBe("1.2.0");
    expect((await readdir(target)).sort()).toEqual(["manifest.json", "page.js"]);
  });

  it("版本没变或应用带的更旧：一个字节都不动", async () => {
    const target = await extension("1.2.0", { "page.js": "装着的" });
    expect(syncFeedExtension(await extension("1.2.0", { "page.js": "应用带的" }), target)).toBe("1.2.0");
    expect(syncFeedExtension(await extension("1.1.0", { "page.js": "更旧的" }), target)).toBe("1.2.0");
    expect(await readFile(path.join(target, "page.js"), "utf8")).toBe("装着的");
  });

  it("应用带的更新：原地覆盖，删掉新版没有的旧文件", async () => {
    const target = await extension("1.1.0", { "page.js": "旧", "old.js": "旧版才有", "filter.test.mjs": "早先拷进来的" });
    expect(syncFeedExtension(await extension("1.2.0", { "page.js": "新", "bridge.js": "新增" }), target)).toBe("1.2.0");
    expect((await readdir(target)).sort()).toEqual(["bridge.js", "manifest.json", "page.js"]);
    expect(await readFile(path.join(target, "page.js"), "utf8")).toBe("新");
  });
});
