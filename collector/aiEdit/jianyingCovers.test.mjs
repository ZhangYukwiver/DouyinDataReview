import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createCoverIndex, ressdkRoot } from "./jianyingCovers.mjs";

const made = [];
afterEach(async () => { await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const item = (id, url) => ({ id, effect_id: id, effect_type: 9, title: "叠化", cover_url: { small: url, static_img: url }, extra: "{}" });

async function cache(rows) {
  const root = await mkdtemp(path.join(tmpdir(), "jy-ressdk-"));
  made.push(root);
  await mkdir(path.join(root, "123"));
  const db = new DatabaseSync(path.join(root, "123", "rp.db"));
  db.exec("CREATE TABLE http_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL, response_body TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO http_cache (url, response_body) VALUES (?, ?)");
  rows.forEach((body, index) => insert.run(`/artist/v1/panel/${index}`, body));
  return { root, db };
}

describe("Jianying cover index", () => {
  it("finds covers by resource id or effect id from Jianying's panel cache and rereads when it changes", async () => {
    const { root, db } = await cache([
      JSON.stringify({ data: { effect_item_list: [item("7049979667406656014", "https://p3.byteimg.com/a.png?x-expires=1&x-signature=x%3D")] } }),
      "不是 JSON",
    ]);
    const index = createCoverIndex({ root });
    let cover = await index.lookup();
    expect(cover({ resource_id: "7049979667406656014", effect_id: "1" })).toBe("https://p3.byteimg.com/a.png?x-expires=1&x-signature=x%3D");
    expect(cover({ resource_id: "9", effect_id: "9" })).toBeNull();
    // 剪映又打开了一个面板：库变了就重读（先用上一份，后台读完下次查就有）
    // 接口原文里斜杠可能转义成 \/
    db.prepare("INSERT INTO http_cache (url, response_body) VALUES (?, ?)").run("/next", '[{"id":"322577","effect_id":"322577","cover_url":{"small":"https:\\/\\/p3.byteimg.com\\/b.png"}}]');
    db.close();
    await index.lookup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    cover = await index.lookup();
    expect(cover({ resource_id: "6724845717472416269", effect_id: "322577" })).toBe("https://p3.byteimg.com/b.png");
  });

  it("has nothing when Jianying never cached a panel", async () => {
    const cover = await createCoverIndex({ root: path.join(tmpdir(), "no-such-jianying") }).lookup();
    expect(cover({ resource_id: "1" })).toBeNull();
    expect(ressdkRoot({ platform: "darwin", home: "/Users/a" })).toBe(path.join("/Users/a", "Movies", "JianyingPro", "User Data", "Cache", "ressdk_db"));
    expect(ressdkRoot({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" } })).toBe(path.join("C:\\L", "JianyingPro", "User Data", "Cache", "ressdk_db"));
    expect(ressdkRoot({ platform: "linux" })).toBeNull();
  });
});
