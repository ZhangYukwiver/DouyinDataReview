import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RELEASE_NOTES } from "./releaseNotes";

describe("RELEASE_NOTES", () => {
  it("matches package.json and the top of .github/release-notes.md", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    // Windows 上 checkout 出来是 CRLF
    const [head, ...lines] = readFileSync(".github/release-notes.md", "utf8").replace(/\r\n/gu, "\n").split("\n\n## ")[0].split("\n");
    const notes = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1"));
    expect(RELEASE_NOTES.version).toBe(pkg.version);
    expect(head).toBe(`## v${RELEASE_NOTES.version} ${RELEASE_NOTES.title}`);
    expect(RELEASE_NOTES.notes).toEqual(notes);
  });
});
