import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseReleaseNotes } from "./releaseNotes";

describe("parseReleaseNotes", () => {
  const markdown = readFileSync(".github/release-notes.md", "utf8");

  it("reads this version's notes from the top of .github/release-notes.md, which must match package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const [parsed, ...rest] = parseReleaseNotes(markdown);
    expect(rest).toEqual([]);
    expect(parsed?.version).toBe(pkg.version);
    expect(parsed?.title).toBeTruthy();
    expect(parsed?.notes.length).toBeGreaterThan(0);
    // Windows 上 checkout 出来是 CRLF
    expect(parseReleaseNotes(markdown.replace(/\n/gu, "\r\n"))).toEqual([parsed]);
  });

  it("keeps only the change lines as plain text and stops before the next section", () => {
    expect(parseReleaseNotes("## v2.0.0 新版\n\n- 接上 [openfilm](https://x) 的**做法**\n- 用 `MP4`\n\n验证：都过了\n\n## 安装\n\n- 不该出现")).toEqual([{
      version: "2.0.0",
      title: "新版",
      notes: ["接上 openfilm 的做法", "用 MP4"],
    }]);
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("没有版本标题")).toEqual([]);
  });

  it("reads several notes files joined together in order, keeping each version once", () => {
    const file = (version) => `## v${version} 第 ${version} 版\n\n- 改了 ${version}\n\n## 安装\n\n- 装`;
    const parsed = parseReleaseNotes([file("1.2.0"), file("1.2.0"), file("1.1.0")].join("\n\n"));
    expect(parsed.map((release) => [release.version, release.notes])).toEqual([["1.2.0", ["改了 1.2.0"]], ["1.1.0", ["改了 1.1.0"]]]);
  });
});
