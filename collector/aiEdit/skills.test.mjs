import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { createSkills, parseSkillFile, windowsEnv } from "./skills.mjs";

const NODE = process.execPath;
const windows = process.platform === "win32";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

/** 起一个技能管理器：数据根在临时目录，登录 shell 就用本进程的环境，不走代理。 */
async function manager(options = {}) {
  const root = await temporaryDirectory("ai-edit-skills-");
  const skills = createSkills({ root, shellEnv: async () => ({ ...process.env }), proxy: async () => null, ...options });
  cleanups.push(() => skills.close());
  return { skills, root, base: await realpath(root) };
}

async function put(folder, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(folder, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

const skillFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n照着做。\n`;
const exists = (file) => stat(file).then(() => true, () => false);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error("等不到");
    await delay(50);
  }
}

/** 一个只有一条技能的本机文件夹，装好返回。 */
async function folderSkill(skills, files = {}) {
  const folder = await temporaryDirectory("skill-pack-");
  await put(folder, { "SKILL.md": skillFile("runner", "跑命令"), ...files });
  const { installed } = await skills.install(folder);
  return { skill: installed[0], folder: await realpath(folder) };
}

/** 起一个每 200ms 打一行的服务就退出的启动器（常见写法）：argv 是输出怎么给它（inherit / ignore）和 pid 文件名。 */
const STARTER = [
  "import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import path from 'node:path';",
  "const [stdio, name] = process.argv.slice(2);",
  "const service = spawn(process.execPath, ['-e', \"setInterval(() => console.log('tick'), 200)\"], { stdio });",
  "writeFileSync(path.join(process.env.DY2_WORK_DIR, `${name}.pid`), String(service.pid));",
  "service.unref();",
].join("\n");

/** 一个只认得 dirs 的 Windows 环境（测试在哪个系统上跑都一样）。 */
const windowsShell = (dirs, home) => async () => ({ PATH: dirs.join(";"), PATHEXT: ".EXE;.CMD", LOCALAPPDATA: home, APPDATA: home, ProgramFiles: home, ProgramW6432: home });

/** GitHub 风格的 zip：外层包一个 <repo>-<ref>/。 */
const repoZip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, typeof text === "string" ? strToU8(text) : text])));

function github(answer) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = answer(url);
    return typeof body === "number" ? new Response("no", { status: body }) : new Response(body);
  };
  return { fetchImpl, calls };
}

describe("parseSkillFile", () => {
  it("reads name and description loosely and falls back to the folder name", () => {
    expect(parseSkillFile("\uFEFF---\r\nname: Alpha\r\ndescription: >-\r\n  第一行\r\n  第二行\r\nextra: [1]\r\n---\r\n正文", "dir")).toEqual({ name: "Alpha", description: "第一行 第二行" });
    // 冒号没加引号，YAML 解析不了：按行抠
    expect(parseSkillFile("---\nname: \"beta\"\ndescription: Use when: the user asks\n---\n", "dir")).toEqual({ name: "beta", description: "Use when: the user asks" });
    expect(parseSkillFile("# 没有 YAML 头\n", "plain")).toEqual({ name: "plain", description: "" });
    expect(parseSkillFile("---\nname: 2048\n---\n", "dir").name).toBe("2048");
    expect(parseSkillFile(`---\nname: long\ndescription: ${"长".repeat(400)}\n---\n`, "dir").description).toHaveLength(300);
    // 用目录名时也合并空白、截到 80 字
    expect(parseSkillFile("# 没写 name\n", " my\n  tool\t").name).toBe("my tool");
    expect(parseSkillFile("---\ndescription: x\n---\n", "长".repeat(100)).name).toBe("长".repeat(80));
  });

  it("still reads block and multi-line descriptions when another key is not valid YAML", () => {
    // argument-hint 没加引号，整段 YAML 解析不了：name、description 各解各的
    const broken = "argument-hint: [pr-number] [priority]";
    expect(parseSkillFile(`---\nname: review\ndescription: >-\n  Review a pull request\n  and leave comments.\n${broken}\n---\n`, "dir"))
      .toEqual({ name: "review", description: "Review a pull request and leave comments." });
    expect(parseSkillFile(`---\nname: notes\ndescription: |\n  第一行\n  第二行\n${broken}\n---\n`, "dir").description).toBe("第一行 第二行");
    // 续行里带冒号，这一块自己也解不了：冒号后面的连同续行都拿上
    expect(parseSkillFile("---\nname: pdf\ndescription: Work with PDF files.\n  Triggers: merge, split, rotate.\n---\n", "dir").description)
      .toBe("Work with PDF files. Triggers: merge, split, rotate.");
  });
});

describe("skills registry", () => {
  it("finds skills in a local folder by the discovery rules and registers them in place", async () => {
    const { skills, base } = await manager();
    const folder = await temporaryDirectory("skill-pack-");
    await put(folder, {
      "skills/alpha/SKILL.md": skillFile("Alpha Tool", "第一个"),
      "skills/alpha/nested/SKILL.md": skillFile("nested", "技能里面的不算"),
      ".claude/skills/beta/SKILL.md": "---\nname: beta\ndescription: Use when: the user asks\n---\n",
      "plain/SKILL.md": "# 没有 YAML 头\n",
      "node_modules/dep/SKILL.md": skillFile("dep", "依赖里的不算"),
      ".hidden/gamma/SKILL.md": skillFile("gamma", "其他点开头的目录不算"),
      // 本机文件夹只认往下两层，第三层只认 .claude/skills/x 这类
      "lib/skills/three/SKILL.md": skillFile("three", "普通的第 3 层不算"),
      "a/b/c/d/SKILL.md": skillFile("depth four", "第 4 层不算"),
      "dup1/SKILL.md": skillFile("Same", "一"),
      "dup2/SKILL.md": skillFile("Same", "二"),
    });
    const real = await realpath(folder);
    const { installed } = await skills.install(folder);
    expect(installed.map((skill) => skill.id).sort()).toEqual(["alpha-tool", "beta", "plain", "same", "same-2"]);
    const alpha = installed.find((skill) => skill.id === "alpha-tool");
    expect(alpha).toEqual({
      id: "alpha-tool", name: "Alpha Tool", description: "第一个", root: real, dir: path.join(real, "skills", "alpha"),
      work: path.join(base, "skill-work", "alpha-tool"), source: { type: "folder", path: real },
      enabled: true, trustCommands: false, installedAt: expect.any(String), problem: null,
    });
    expect(installed.find((skill) => skill.id === "beta")).toMatchObject({ description: "Use when: the user asks", dir: path.join(real, ".claude", "skills", "beta") });
    expect(installed.find((skill) => skill.id === "plain")).toMatchObject({ name: "plain", description: "" });
    expect((await skills.list()).map((skill) => skill.name)).toEqual(["Alpha Tool", "beta", "plain", "Same", "Same"]);

    expect((await skills.get("Alpha Tool")).id).toBe("alpha-tool");
    expect((await skills.get("same-2")).description).toBe("二");
    // 名字重了只认 id
    await expect(skills.get("Same")).rejects.toMatchObject({ code: "skill_not_found", status: 404 });

    // 同一个文件夹再登记一次：原来的 id 和开关留着，没了的去掉，新的加上
    await skills.update("alpha-tool", { enabled: false, trustCommands: true });
    await rm(path.join(folder, "plain"), { recursive: true });
    await put(folder, { "fresh/SKILL.md": skillFile("fresh", "新加的") });
    await skills.install(folder);
    const again = await skills.list();
    expect(again.map((skill) => skill.id).sort()).toEqual(["alpha-tool", "beta", "fresh", "same", "same-2"]);
    expect(again.find((skill) => skill.id === "alpha-tool")).toMatchObject({ enabled: false, trustCommands: true });
    expect((await skills.enabled()).map((skill) => skill.id)).not.toContain("alpha-tool");
    await expect(skills.update("alpha-tool", { enabled: "yes" })).rejects.toMatchObject({ code: "skill_patch_invalid" });

    // 本机文件夹删掉只去登记，文件留着
    expect(await skills.remove("beta")).toEqual({ removed: true });
    expect(await exists(path.join(folder, ".claude", "skills", "beta", "SKILL.md"))).toBe(true);
    await expect(skills.get("beta")).rejects.toMatchObject({ code: "skill_not_found" });

    // 登记表存盘了：换一个管理器读出来一样
    const reloaded = createSkills({ root: base, shellEnv: async () => ({ ...process.env }), proxy: async () => null });
    expect((await reloaded.list()).map((skill) => skill.id).sort()).toEqual(["alpha-tool", "fresh", "same", "same-2"]);
  });

  it("only takes skills near the top of a local folder and says which folder to pick instead", async () => {
    const { skills } = await manager();
    const folder = await temporaryDirectory("skill-broad-");
    // 选了个装着很多项目的大文件夹：技能都埋在深处
    await put(folder, {
      "projects/demo/.claude/skills/demo/SKILL.md": skillFile("demo", "项目里的"),
      "repos/toolbox/skills/maker/SKILL.md": skillFile("maker", "仓库里的"),
    });
    await expect(skills.install(folder)).rejects.toMatchObject({ code: "skill_missing", status: 422, message: expect.stringContaining("技能仓库的根目录") });
    expect(await skills.list()).toEqual([]);
    // 改选项目文件夹、仓库根目录就能装
    expect((await skills.install(path.join(folder, "projects", "demo"))).installed.map((skill) => skill.name)).toEqual(["demo"]);
    expect((await skills.install(path.join(folder, "repos", "toolbox"))).installed.map((skill) => skill.name)).toEqual(["maker"]);
  });

  it("treats a folder with SKILL.md at the top as one skill and reports a missing folder as a problem", async () => {
    const { skills } = await manager();
    const folder = await temporaryDirectory("skill-single-");
    await put(folder, { "SKILL.md": skillFile("单个", "就它一个"), "sub/SKILL.md": skillFile("sub", "不算") });
    const { installed } = await skills.install(folder);
    expect(installed).toHaveLength(1);
    // 名字拼不出 id 时用文件夹名
    expect(installed[0]).toMatchObject({ id: expect.stringMatching(/^skill-single-/u), name: "单个", root: await realpath(folder), dir: await realpath(folder) });

    await rm(folder, { recursive: true, force: true });
    const [gone] = await skills.list();
    expect(gone.problem).toContain("不在了");
    expect(await skills.enabled()).toEqual([]);
    await expect(skills.resolve(gone, "SKILL.md")).rejects.toMatchObject({ code: "skill_unavailable" });
  });

  it("refuses sources it cannot install", async () => {
    const { skills } = await manager();
    await expect(skills.install("hello")).rejects.toMatchObject({ code: "skill_source_invalid", status: 400 });
    await expect(skills.install("https://gitlab.com/a/b")).rejects.toMatchObject({ code: "skill_source_invalid" });
    await expect(skills.install(path.join(tmpdir(), "no-such-skill-folder-xyz"))).rejects.toMatchObject({ code: "skill_missing", status: 422 });
    const empty = await temporaryDirectory("skill-empty-");
    await expect(skills.install(empty)).rejects.toMatchObject({ code: "skill_missing", status: 422 });
  });

  it("refuses folders that would let the AI reach the home folder, the app data or agent settings", async () => {
    const home = await realpath(await temporaryDirectory("skill-home-"));
    const root = path.join(home, "Library", "App", "ai-edit");
    await put(home, {
      ".codex/auth.json": "{\"token\":\"x\"}", ".codex/skills/tool/SKILL.md": skillFile("tool", "Codex 里的技能"),
      ".claude/settings.json": "{}", ".claude/skills/helper/SKILL.md": skillFile("helper", "Claude 里的技能"),
      ".claude/plugins/p/skills/plug/SKILL.md": skillFile("plug", "插件里的"),
      "projects/demo/.claude/skills/demo/SKILL.md": skillFile("demo", "项目里的"),
    });
    const skills = createSkills({ root, home, shellEnv: async () => ({ ...process.env }), proxy: async () => null });
    cleanups.push(() => skills.close());
    // 家目录、它的上层，Claude/Codex 配置目录（skills/ 以外），应用数据目录和它的上层、里面
    for (const folder of [home, "~", "~/.codex", path.join(home, ".claude"), path.join(home, ".claude", "plugins"), path.join(home, "Library"), path.join(home, "Library", "App"), root, path.join(root, "skills")]) {
      await expect(skills.install(folder), folder).rejects.toMatchObject({ code: "skill_source_too_broad", status: 422 });
    }
    expect(await skills.list()).toEqual([]);
    // 配置目录里的 skills/、单个技能、普通项目文件夹照常能装
    expect((await skills.install("~/.codex/skills")).installed.map((skill) => skill.name)).toEqual(["tool"]);
    expect((await skills.install(path.join(home, ".claude", "skills", "helper"))).installed.map((skill) => skill.name)).toEqual(["helper"]);
    expect((await skills.install(path.join(home, "projects", "demo"))).installed.map((skill) => skill.name)).toEqual(["demo"]);
  });

  it("refuses the folders programs keep their settings in and agent folders set in the user's environment", async () => {
    // 应用数据（manager 的临时目录）不在这个家目录里：挡住下面这些的不是「应用数据目录的上层」那条
    const home = await realpath(await temporaryDirectory("skill-home-"));
    await put(home, {
      ".config/tool/SKILL.md": skillFile("config", "配置目录里的"), "Library/Tool/SKILL.md": skillFile("library", "mac 的资料库里的"),
      "AppData/Roaming/tool/SKILL.md": skillFile("roaming", "Windows 的"), "AppData/Local/tool/SKILL.md": skillFile("local", "Windows 的"),
      "agents/codex/x/SKILL.md": skillFile("codex", "CODEX_HOME 里的"), "agents/codex/skills/ok/SKILL.md": skillFile("ok", "CODEX_HOME 的 skills/"),
      "agents/claude/y/SKILL.md": skillFile("claude", "CLAUDE_CONFIG_DIR 里的"),
    });
    const agents = { CODEX_HOME: path.join(home, "agents", "codex"), CLAUDE_CONFIG_DIR: path.join(home, "agents", "claude") };
    const refused = async (skills, folders) => {
      for (const folder of folders) await expect(skills.install(folder), folder).rejects.toMatchObject({ code: "skill_source_too_broad", status: 422 });
      expect(await skills.list()).toEqual([]);
    };

    // 两个配置目录只在用户的登录 shell 里设了，本进程没有
    const mac = (await manager({ home, platform: "darwin", shellEnv: async () => ({ ...process.env, ...agents }) })).skills;
    await refused(mac, ["~/.config", "~/Library", agents.CODEX_HOME, agents.CLAUDE_CONFIG_DIR, path.join(home, "agents")]);
    expect((await mac.install(path.join(agents.CODEX_HOME, "skills"))).installed.map((skill) => skill.name)).toEqual(["ok"]);

    // Windows：变量名大小写不定
    const win = (await manager({ home, platform: "win32", shellEnv: async () => ({ PATH: "", AppData: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") }) })).skills;
    await refused(win, [path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local"), path.join(home, "AppData")]);
  });

  it.skipIf(windows)("follows links to skill folders: one linked from outside is its own package, too broad ones are skipped and said", async () => {
    const home = await realpath(await temporaryDirectory("skill-home-"));
    const { skills } = await manager({ home });
    // 装技能的工具常这样放：真的在 ~/.agents/skills/x，~/.claude/skills/x 是链过去的
    await put(home, {
      ".agents/skills/linked/SKILL.md": skillFile("linked", "链过来的"), ".agents/skills/linked/data/notes.txt": "原来的",
      ".agents/skills/sibling/secret.txt": "旁边别的技能的",
      ".claude/skills/own/SKILL.md": skillFile("own", "本来就在这"),
      ".codex/SKILL.md": skillFile("whole", "整个配置目录"),
    });
    const folder = path.join(home, ".claude", "skills");
    const real = path.join(home, ".agents", "skills", "linked");
    await symlink(real, path.join(folder, "linked"));
    // 同一个技能链了两次、链到包里面的、坏链、链回上层（成环）：都只算一次或者不算
    await symlink(real, path.join(folder, "again"));
    await symlink(path.join(folder, "own"), path.join(folder, "inner"));
    await symlink(path.join(home, "nowhere"), path.join(folder, "broken"));
    await symlink(folder, path.join(folder, "loop"));
    // 链到范围太大的文件夹：不装，结果里说明
    await symlink(path.join(home, ".codex"), path.join(folder, "whole"));

    const { installed, skipped } = await skills.install(folder);
    expect(installed.map((skill) => skill.name).sort()).toEqual(["linked", "own"]);
    expect(installed.find((skill) => skill.name === "own")).toMatchObject({ root: folder, dir: path.join(folder, "own") });
    const linked = installed.find((skill) => skill.name === "linked");
    expect(linked).toMatchObject({ root: real, dir: real, source: { type: "folder", path: folder }, problem: null });
    expect(skipped).toEqual([expect.stringContaining(path.join(folder, "whole"))]);
    expect(skipped[0]).toContain(path.join(home, ".codex"));

    // 链过来的技能读写自己的文件照常，旁边别的技能碰不到
    expect((await skills.readFile(linked, "data/notes.txt")).lines).toBe("1\t原来的\n");
    expect(await skills.writeFile(linked, "data/new.txt", "写的")).toEqual({ path: path.join(real, "data", "new.txt"), bytes: 6 });
    expect(await readFile(path.join(real, "data", "new.txt"), "utf8")).toBe("写的");
    await expect(skills.readFile(linked, "../sibling/secret.txt")).rejects.toMatchObject({ code: "path_outside_skill" });

    // 只有范围太大的：报错里说清楚是哪一个
    const only = await temporaryDirectory("skill-links-");
    await symlink(path.join(home, ".codex"), path.join(only, "whole"));
    await expect(skills.install(only)).rejects.toMatchObject({ code: "skill_source_too_broad", status: 422, message: expect.stringContaining(path.join(await realpath(only), "whole")) });
  });
});

// 造超大、上千个文件的 zip 再解压，Windows CI 上一条要六七秒
describe("GitHub install", { timeout: 30_000 }, () => {
  it("downloads the zip, strips the outer folder, keeps switches on reinstall and deletes the package with its last skill", async () => {
    let version = 1;
    const zips = {
      1: repoZip({
        "Toolbox-main/README.md": "说明",
        "Toolbox-main/skills/maker/SKILL.md": skillFile("maker", "做东西"),
        "Toolbox-main/skills/maker/scripts/build.mjs": "#!/usr/bin/env node\nconsole.log('ok')\n",
        "Toolbox-main/.claude/skills/helper/SKILL.md": skillFile("helper", "帮手"),
        "Toolbox-main/.git/config": "[core]",
        "__MACOSX/Toolbox-main/._README.md": "junk",
      }),
      2: repoZip({
        "Toolbox-v2/README.md": "说明 v2",
        "Toolbox-v2/skills/maker/SKILL.md": skillFile("maker", "做东西 v2"),
      }),
    };
    const { fetchImpl, calls } = github(() => zips[version]);
    const { skills, base } = await manager({ fetchImpl });
    const packageRoot = path.join(base, "skills", "owner_toolbox");

    const { installed } = await skills.install("https://github.com/Owner/Toolbox.git");
    expect(calls).toEqual(["https://codeload.github.com/Owner/Toolbox/zip/HEAD"]);
    expect(installed.map((skill) => skill.name).sort()).toEqual(["helper", "maker"]);
    const maker = installed.find((skill) => skill.name === "maker");
    expect(maker).toMatchObject({
      root: packageRoot, dir: path.join(packageRoot, "skills", "maker"), enabled: true, trustCommands: false,
      source: { type: "github", url: "https://github.com/Owner/Toolbox", ref: null, subdir: null },
    });
    expect(await readFile(path.join(packageRoot, "README.md"), "utf8")).toBe("说明");
    expect(await exists(path.join(packageRoot, ".git"))).toBe(false);
    expect(await exists(path.join(packageRoot, ".claude", "skills", "helper", "SKILL.md"))).toBe(true);
    expect(await exists(path.join(base, "skills", "__MACOSX"))).toBe(false);
    if (!windows) expect((await stat(path.join(maker.dir, "scripts", "build.mjs"))).mode & 0o100).toBeTruthy();

    await skills.update(maker.id, { enabled: false, trustCommands: true });
    version = 2;
    const again = await skills.install("https://github.com/owner/toolbox/tree/v2/skills/maker");
    expect(calls[1]).toBe("https://codeload.github.com/owner/toolbox/zip/v2");
    expect(again.installed).toEqual([expect.objectContaining({
      id: maker.id, description: "做东西 v2", enabled: false, trustCommands: true,
      source: { type: "github", url: "https://github.com/owner/toolbox", ref: "v2", subdir: "skills/maker" },
    })]);
    // 新版本里没有 helper 了：登记跟着去掉；包整个换成新的，没留临时目录
    expect((await skills.list()).map((skill) => skill.name)).toEqual(["maker"]);
    expect(await readFile(path.join(packageRoot, "README.md"), "utf8")).toBe("说明 v2");
    expect((await readdir(path.join(base, "skills"))).sort()).toEqual([".files-owner_toolbox.json", "owner_toolbox"]);

    await skills.remove(maker.id);
    expect(await exists(packageRoot)).toBe(false);
    expect(await readdir(path.join(base, "skills"))).toEqual([]);
    expect(await skills.list()).toEqual([]);
  });

  it("keeps the package while another skill from it is still installed", async () => {
    const zip = repoZip({ "Pack-main/one/SKILL.md": skillFile("one", "1"), "Pack-main/two/SKILL.md": skillFile("two", "2") });
    const { skills, base } = await manager({ fetchImpl: github(() => zip).fetchImpl });
    await skills.install("github.com/me/pack");
    await skills.remove("one");
    expect(await exists(path.join(base, "skills", "me_pack", "two", "SKILL.md"))).toBe(true);
    await skills.remove("two");
    expect(await exists(path.join(base, "skills", "me_pack"))).toBe(false);
  });

  it("finds skills deeper in a repository than in a local folder", async () => {
    // 插件市场式的仓库：plugins/<插件>/skills/<技能>/SKILL.md 在第 4 层；本机文件夹的两层限制不管 GitHub
    const zip = repoZip({
      "Market-main/plugins/kit/skills/deep/SKILL.md": skillFile("deep", "第 4 层还算"),
      "Market-main/x1/x2/x3/x4/x5/SKILL.md": skillFile("too deep", "第 5 层不算"),
    });
    const { skills } = await manager({ fetchImpl: github(() => zip).fetchImpl });
    expect((await skills.install("https://github.com/me/market")).installed.map((skill) => skill.name)).toEqual(["deep"]);
  });

  it("refuses unsafe, empty, oversized and missing packages without leaving files behind", async () => {
    let body;
    const { skills, base } = await manager({ fetchImpl: github(() => body).fetchImpl });
    const left = async () => readdir(path.join(base, "skills"));

    body = repoZip({ "Evil-main/SKILL.md": skillFile("evil", "x"), "Evil-main/../../escape.txt": "x" });
    await expect(skills.install("https://github.com/a/evil")).rejects.toMatchObject({ code: "skill_bad_zip", status: 422 });
    expect(await exists(path.join(base, "escape.txt"))).toBe(false);
    expect(await left()).toEqual([]);

    body = repoZip({ "Docs-main/README.md": "没有技能" });
    await expect(skills.install("https://github.com/a/docs")).rejects.toMatchObject({ code: "skill_missing", status: 422 });
    body = repoZip({ "Docs-main/README.md": "没有技能" });
    await expect(skills.install("https://github.com/a/docs/tree/main/skills/nope")).rejects.toMatchObject({ code: "skill_missing" });

    body = repoZip(Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [`Many-main/f${index}.txt`, ""])));
    await expect(skills.install("https://github.com/a/many")).rejects.toMatchObject({ code: "skill_too_many_files", status: 413 });

    body = "<html>不是 zip</html>";
    await expect(skills.install("https://github.com/a/html")).rejects.toMatchObject({ code: "skill_bad_zip" });

    body = 404;
    await expect(skills.install("https://github.com/a/private")).rejects.toMatchObject({ code: "skill_download_failed", status: 422 });
    expect(await left()).toEqual([]);
    expect(await skills.list()).toEqual([]);
  });

  it("keeps repositories whose names join the same way apart and does not hand trust to a different repository", async () => {
    const { fetchImpl } = github((url) => repoZip({ "Music-main/SKILL.md": skillFile("music", url), "Music-main/run.mjs": url }));
    const { skills } = await manager({ fetchImpl });
    const [first] = (await skills.install("https://github.com/cool-dev/music")).installed;
    await skills.update(first.id, { trustCommands: true });
    const [second] = (await skills.install("https://github.com/cool/dev-music")).installed;
    expect(second.root).not.toBe(first.root);
    expect(second).toMatchObject({ trustCommands: false, source: { url: "https://github.com/cool/dev-music" } });
    expect(await readFile(path.join(first.root, "run.mjs"), "utf8")).toContain("/cool-dev/music/");
    expect((await skills.list()).map((skill) => [skill.source.url, skill.trustCommands])).toEqual([
      ["https://github.com/cool-dev/music", true], ["https://github.com/cool/dev-music", false],
    ]);

    // 目录还是撞上了（GitHub 上没有带下划线的公开用户名，理论上的情况）：换了来源就不沿用「不用问」
    const [third] = (await skills.install("https://github.com/a_b/c")).installed;
    await skills.update(third.id, { trustCommands: true });
    const [fourth] = (await skills.install("https://github.com/a/b_c")).installed;
    expect(fourth).toMatchObject({ root: third.root, trustCommands: false, source: { url: "https://github.com/a/b_c" } });
  });

  it("keeps what the skill saved inside its package when the same repository is reinstalled", async () => {
    let version = 1;
    const zips = {
      1: repoZip({
        "Studio-main/README.md": "v1", "Studio-main/media/guide.md": "指南", "Studio-main/scripts/legacy.mjs": "旧脚本",
        "Studio-main/skills/studio/SKILL.md": skillFile("studio", "工作室"),
      }),
      2: repoZip({
        "Studio-main/README.md": "v2", "Studio-main/media/guide.md": "指南 v2", "Studio-main/skills/studio/SKILL.md": skillFile("studio", "工作室 v2"),
      }),
    };
    const { skills, base } = await manager({ fetchImpl: github(() => zips[version]).fetchImpl });
    const [skill] = (await skills.install("https://github.com/me/studio")).installed;
    // 技能跑起来以后自己存进包里的：zip 里没有的顶层目录、zip 里有的目录下面多出来的、技能文件夹里的标记
    await put(skill.root, {
      "data/songs/a.json": "{}", "node_modules/dep/index.js": "x", "media/recordings/me.wav": "wav", "skills/studio/marker.txt": "here",
      "README.md": "本地改过",
    });
    version = 2;
    const [again] = (await skills.install("https://github.com/me/studio")).installed;
    expect(again).toMatchObject({ id: skill.id, description: "工作室 v2" });
    const read = (name) => readFile(path.join(skill.root, ...name.split("/")), "utf8");
    expect(await read("data/songs/a.json")).toBe("{}");
    expect(await read("node_modules/dep/index.js")).toBe("x");
    expect(await read("media/recordings/me.wav")).toBe("wav");
    expect(await read("skills/studio/marker.txt")).toBe("here");
    // zip 里有的以新版本为准；旧版本带、新版本删掉的不留
    expect(await read("README.md")).toBe("v2");
    expect(await read("media/guide.md")).toBe("指南 v2");
    expect(await exists(path.join(skill.root, "scripts"))).toBe(false);
    expect((await readdir(path.join(base, "skills"))).sort()).toEqual([".files-me_studio.json", "me_studio"]);

    // 记着 zip 路径的表坏了：照样能更新，数据都留着
    await writeFile(path.join(base, "skills", ".files-me_studio.json"), "{坏了");
    await skills.install("https://github.com/me/studio");
    expect(await read("data/songs/a.json")).toBe("{}");
    expect(await read("README.md")).toBe("v2");
  });

  it.skipIf(windows)("gives native programs from the zip the execute bit", async () => {
    const zip = repoZip({
      "Tool-main/SKILL.md": skillFile("tool", "自带程序"),
      "Tool-main/bin/linux-tool": new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      "Tool-main/bin/mac-tool": new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]),
      "Tool-main/bin/universal-tool": new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]),
      "Tool-main/bin/data.bin": new Uint8Array([1, 2, 3, 4, 5]),
    });
    const { skills } = await manager({ fetchImpl: github(() => zip).fetchImpl });
    const [skill] = (await skills.install("https://github.com/me/tool")).installed;
    const executable = async (name) => Boolean((await stat(path.join(skill.root, "bin", name))).mode & 0o100);
    expect(await executable("linux-tool")).toBe(true);
    expect(await executable("mac-tool")).toBe(true);
    expect(await executable("universal-tool")).toBe(true);
    expect(await executable("data.bin")).toBe(false);
  });

  it("keeps the registration and the files when removing cannot save the registry", async () => {
    const zip = repoZip({ "Pack-main/SKILL.md": skillFile("pack", "包") });
    const { skills, base } = await manager({ fetchImpl: github(() => zip).fetchImpl });
    const [skill] = (await skills.install("https://github.com/me/pack")).installed;
    // 登记表的临时文件写不了
    await mkdir(path.join(base, "skills.json.tmp"));
    await expect(skills.remove(skill.id)).rejects.toBeTruthy();
    expect((await skills.list()).map((item) => item.id)).toEqual([skill.id]);
    expect(await exists(path.join(skill.root, "SKILL.md"))).toBe(true);
    await rm(path.join(base, "skills.json.tmp"), { recursive: true });
    expect(await skills.remove(skill.id)).toEqual({ removed: true });
    expect(await exists(skill.root)).toBe(false);
  });

  // 只读目录挡不住 root；Windows 上权限位不是这么管的
  it.skipIf(windows || process.getuid?.() === 0)("drops the registration and the package folder even when some files inside cannot be deleted yet", async () => {
    const zip = repoZip({ "Pack-main/SKILL.md": skillFile("pack", "包") });
    const { skills, base } = await manager({ fetchImpl: github(() => zip).fetchImpl });
    const [skill] = (await skills.install("https://github.com/me/pack")).installed;
    await mkdir(path.join(skill.root, "cache", "x"), { recursive: true });
    await chmod(path.join(skill.root, "cache"), 0o500);
    cleanups.push(async () => {
      for (const name of await readdir(path.join(base, "skills")).catch(() => [])) await chmod(path.join(base, "skills", name, "cache"), 0o700).catch(() => undefined);
    });
    expect(await skills.remove(skill.id)).toEqual({ removed: true });
    expect(await skills.list()).toEqual([]);
    expect(await exists(skill.root)).toBe(false);
  });

  it("says GitHub is unreachable when the download throws", async () => {
    const { skills } = await manager({ fetchImpl: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); } });
    await expect(skills.install("https://github.com/a/b")).rejects.toMatchObject({ code: "skill_download_failed", status: 502, message: expect.stringContaining("ECONNRESET") });
  });
});

describe("skill files", () => {
  it("keeps paths inside the package and the work folder and protects the skill's own files", async () => {
    const { skills } = await manager();
    const { skill, folder } = await folderSkill(skills, {
      "scripts/run.mjs": "", "references/a.md": "", "agents/openai.yaml": "", "data/notes.txt": "hi", ".git/config": "", "node_modules/x/index.js": "",
    });
    const outside = await temporaryDirectory("skill-outside-");
    expect(await skills.resolve(skill, "data/notes.txt")).toBe(path.join(folder, "data", "notes.txt"));
    expect(await skills.resolve(skill, path.join(folder, "data", "notes.txt"))).toBe(path.join(folder, "data", "notes.txt"));
    expect(await skills.resolve(skill, "~work/draft.json")).toBe(path.join(skill.work, "draft.json"));
    expect(await skills.resolve(skill, "~work/new/deeper/file.txt", { write: true })).toBe(path.join(skill.work, "new", "deeper", "file.txt"));
    expect(await skills.resolve(skill, "scripts/run.mjs")).toBe(path.join(folder, "scripts", "run.mjs"));
    await expect(skills.resolve(skill, "../outside.txt")).rejects.toMatchObject({ code: "path_outside_skill", status: 403 });
    await expect(skills.resolve(skill, path.join(outside, "x.txt"))).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.resolve(skill, "~work/../../escape.txt", { write: true })).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.resolve(skill, "a\0b")).rejects.toMatchObject({ code: "path_invalid", status: 400 });
    for (const p of ["SKILL.md", "skill.md", "scripts/run.mjs", "scripts/new.mjs", "references/new.md", "agents/x.yaml", ".git/config", "node_modules/x/index.js", "data/node_modules/y.js", "~work/.git/x"]) {
      await expect(skills.resolve(skill, p, { write: true }), p).rejects.toMatchObject({ code: "path_protected", status: 403 });
    }
    expect(await skills.resolve(skill, "data/scripts/ok.txt", { write: true })).toBe(path.join(folder, "data", "scripts", "ok.txt"));
  });

  it.skipIf(windows)("does not follow links out of the package", async () => {
    const { skills } = await manager();
    const { skill, folder } = await folderSkill(skills);
    const outside = await temporaryDirectory("skill-outside-");
    await writeFile(path.join(outside, "secret.txt"), "外面的");
    await symlink(outside, path.join(folder, "link"));
    await symlink(path.join(outside, "nope.txt"), path.join(folder, "dangling.txt"));
    await symlink(path.join(folder, "SKILL.md"), path.join(folder, "inside.md"));
    await symlink(path.join(folder, "SKILL.md"), path.join(outside, "back.md"));
    // 界外的路径按字面就拒，不去 realpath 它（链回包里的也不认）
    await expect(skills.resolve(skill, path.join(outside, "back.md"))).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.resolve(skill, "link/secret.txt")).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.readFile(skill, "link/secret.txt")).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.resolve(skill, "link/new.txt", { write: true })).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.writeFile(skill, "dangling.txt", "x")).rejects.toMatchObject({ code: "path_outside_skill" });
    expect(await exists(path.join(outside, "nope.txt"))).toBe(false);
    // 链到包里面的照常能读
    expect(await skills.resolve(skill, "inside.md")).toBe(path.join(folder, "SKILL.md"));
  });

  it("lists folders, pages and searches text, and refuses secrets", async () => {
    const { skills } = await manager();
    const lines = Array.from({ length: 1_000 }, (_, index) => (index === 9 || index === 11 || index === 49 ? `needle ${index + 1}` : `line ${index + 1}`));
    const { skill, folder } = await folderSkill(skills, {
      "data/long.txt": `${lines.join("\n")}\n`,
      "data/wide.txt": Array.from({ length: 500 }, () => "宽".repeat(1_990)).join("\n"),
      "data/huge-line.txt": "长".repeat(5_000),
      "data/sound.wav": Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]),
      "data/gbk.txt": Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]),
      "node_modules/dep/index.js": "",
      ".env": "KEY=1", "config/api_key.txt": "k", "keys/id_rsa": "k", "keys/server.pem": "k",
      ".env.local": "KEY=2", "config/client_secret.json": "{}", "config/token.json": "{}",
      ".env.example": "KEY=", "references/credentials.md": "凭据存在系统钥匙串里", "models/tokenizer.json": "{}",
      "models/special_tokens_map.json": "{}", "models/added_tokens.json": "{}", ".env.defaults": "KEY=",
    });

    const top = await skills.readFile(skill, "");
    expect(top).toMatchObject({ path: folder, kind: "dir" });
    expect(top.entries.slice(0, 3)).toEqual([
      { name: "config", kind: "dir", size: null }, { name: "data", kind: "dir", size: null }, { name: "keys", kind: "dir", size: null },
    ]);
    expect(top.entries).toContainEqual({ name: "node_modules", kind: "dir", size: null });
    expect(top.entries).toContainEqual({ name: "SKILL.md", kind: "file", size: Buffer.byteLength(skillFile("runner", "跑命令")) });

    const own = await skills.readFile(skill);
    expect(own).toMatchObject({ kind: "text", from: 1, truncated: false });
    expect(own.lines.startsWith("1\t---\n2\tname: runner\n")).toBe(true);

    const first = await skills.readFile(skill, "data/long.txt");
    expect(first).toMatchObject({ from: 1, to: 400, total_lines: 1_000, truncated: true });
    const tail = await skills.readFile(skill, "data/long.txt", { offset: 990, limit: 50 });
    expect(tail).toMatchObject({ from: 990, to: 1_000, truncated: false });
    expect(tail.lines.split("\n")[0]).toBe("990\tline 990");

    const wide = await skills.readFile(skill, "data/wide.txt");
    expect(wide.lines.length).toBeLessThanOrEqual(40_000);
    expect(wide.truncated).toBe(true);
    expect(wide.to).toBeLessThan(25);
    expect((await skills.readFile(skill, "data/huge-line.txt")).lines).toContain("（这一行还有 3000 字）");

    const found = await skills.readFile(skill, "data/long.txt", { search: "NEEDLE" });
    expect(found).toMatchObject({ kind: "text", matches: 3, total_lines: 1_000, truncated: false });
    expect(found.lines).toBe([
      "8-\tline 8", "9-\tline 9", "10:\tneedle 10", "11-\tline 11", "12:\tneedle 12", "13-\tline 13", "14-\tline 14", "--",
      "48-\tline 48", "49-\tline 49", "50:\tneedle 50", "51-\tline 51", "52-\tline 52", "",
    ].join("\n"));

    expect(await skills.readFile(skill, "data/sound.wav")).toEqual({ path: path.join(folder, "data", "sound.wav"), kind: "binary", size: 8 });
    expect((await skills.readFile(skill, "data/gbk.txt")).lines).toBe("1\t中文\n");
    for (const secret of [".env", "config/api_key.txt", "keys/id_rsa", "keys/server.pem", ".env.local", "config/client_secret.json", "config/token.json"]) {
      await expect(skills.readFile(skill, secret), secret).rejects.toMatchObject({ code: "secret_file", status: 403 });
    }
    // 名字里带关键词的说明文档、模板、分词表、词表（复数 tokens）不是密钥
    for (const doc of [".env.example", ".env.defaults", "references/credentials.md", "models/tokenizer.json", "models/special_tokens_map.json", "models/added_tokens.json"]) {
      expect((await skills.readFile(skill, doc)).kind, doc).toBe("text");
    }
    await expect(skills.readFile(skill, "data/missing.txt")).rejects.toMatchObject({ code: "file_not_found", status: 404 });
  });

  it("refuses token files but reads model vocabularies", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills, {
      "config/tokens.json": "{}", "config/auth_tokens.json": "{}", "config/access-tokens.json": "{}", ".tokens": "x",
      "models/special_tokens_map.json": "{}", "models/added_tokens.json": "{}", "models/tokenizer_config.json": "{}", "models/vocab.json": "{}", "models/vocab.txt": "a",
    });
    for (const secret of ["config/tokens.json", "config/auth_tokens.json", "config/access-tokens.json", ".tokens"]) {
      await expect(skills.readFile(skill, secret), secret).rejects.toMatchObject({ code: "secret_file", status: 403 });
    }
    for (const vocab of ["models/special_tokens_map.json", "models/added_tokens.json", "models/tokenizer_config.json", "models/vocab.json", "models/vocab.txt"]) {
      expect((await skills.readFile(skill, vocab)).kind, vocab).toBe("text");
    }
  });

  it("writes UTF-8 files with size limits and creates folders", async () => {
    const { skills } = await manager();
    const { skill, folder } = await folderSkill(skills);
    const written = await skills.writeFile(skill, "~work/drafts/plan.json", "\uFEFF{\"step\":1}");
    expect(written).toEqual({ path: path.join(skill.work, "drafts", "plan.json"), bytes: 10 });
    expect(await readFile(written.path, "utf8")).toBe("{\"step\":1}");
    expect(await skills.writeFile(skill, "~work/drafts/plan.json", "\n中", { append: true })).toEqual({ path: written.path, bytes: 4 });
    expect(await readFile(written.path, "utf8")).toBe("{\"step\":1}\n中");
    expect((await skills.writeFile(skill, "data/drafts/a.json", "{}")).path).toBe(path.join(folder, "data", "drafts", "a.json"));

    const big = "x".repeat(2 * 1024 * 1024);
    expect((await skills.writeFile(skill, "~work/big.txt", big)).bytes).toBe(big.length);
    await expect(skills.writeFile(skill, "~work/big.txt", "y", { append: true })).rejects.toMatchObject({ code: "file_too_large", status: 413 });
    await expect(skills.writeFile(skill, "~work/bigger.txt", `${big}y`)).rejects.toMatchObject({ code: "file_too_large" });
    await expect(skills.writeFile(skill, "~work/drafts", "x")).rejects.toMatchObject({ code: "path_is_dir" });
    await expect(skills.writeFile(skill, "~work/x.txt", 1)).rejects.toMatchObject({ code: "content_invalid" });
    await expect(skills.writeFile(skill, "SKILL.md", "改说明")).rejects.toMatchObject({ code: "path_protected" });
  });
});

// 要起真进程，Windows CI 上慢
describe("skill file errors", () => {
  it("says why a file cannot be written or read instead of a bare system error", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);
    await skills.writeFile(skill, "~work/a.json", "{}");
    // 路径里有一段已经是文件
    await expect(skills.writeFile(skill, "~work/a.json/b.json", "{}")).rejects.toMatchObject({ code: "file_unwritable", status: 422, message: expect.stringContaining("a.json") });
    if (windows || process.getuid?.() === 0) return;
    await writeFile(path.join(skill.work, "locked.txt"), "x");
    await chmod(path.join(skill.work, "locked.txt"), 0o000);
    await expect(skills.readFile(skill, "~work/locked.txt")).rejects.toMatchObject({ code: "file_unreadable", status: 422, message: expect.stringContaining("EACCES") });
  });
});

describe("skill commands", { timeout: 20_000 }, () => {
  it("runs a command without a shell and returns exit code, output and the log", async () => {
    const { skills } = await manager();
    const { skill, folder } = await folderSkill(skills, { "data/.keep": "" });

    const result = await skills.run(skill, [NODE, "-e", "console.log('hi'); console.error('wa' + 'rn'); process.exit(3)"]);
    // 短的在前：压缩历史时结果只留开头，日志和产出不能被长输出挤掉
    expect(Object.keys(result)).toEqual(["job_id", "exit_code", "duration_seconds", "truncated", "log", "new_files", "stderr_tail", "stdout_head", "stdout_tail"]);
    expect(result).toMatchObject({ job_id: expect.stringMatching(/^[0-9a-f]{16}$/u), exit_code: 3, stdout_head: "hi\n", stdout_tail: "", truncated: false });
    expect(result.stderr_tail).toContain("warn");
    expect(result.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(result.log).toBe(path.join(skill.work, ".runs", `${result.job_id}.log`));
    const log = await readFile(result.log, "utf8");
    expect(log).toContain("hi");
    expect(log).toContain("warn");
    // 日志也能用 read_skill 搜
    expect((await skills.readFile(skill, result.log, { search: "warn" })).matches).toBe(1);

    const seen = JSON.parse((await skills.run(skill, [NODE, "-e", [
      "console.log(JSON.stringify({ cwd: process.cwd(), dir: process.env.DY2_SKILL_DIR, root: process.env.DY2_SKILL_ROOT, work: process.env.DY2_WORK_DIR,",
      "color: process.env.NO_COLOR, force: process.env.FORCE_COLOR, py: process.env.PYTHONIOENCODING, utf8: process.env.PYTHONUTF8, proxy: process.env.NODE_USE_ENV_PROXY,",
      "noProxy: process.env.NO_PROXY, arg: process.argv[1], flag: process.argv[2] }))",
    ].join(" "), "~work/a.json", "--out=~work/b"])).stdout_head);
    expect(seen).toMatchObject({
      cwd: folder, dir: skill.dir, root: skill.root, work: skill.work, color: "1", force: "0", py: "utf-8", utf8: "1", proxy: "1",
      arg: path.join(skill.work, "a.json"), flag: `--out=${path.join(skill.work, "b")}`,
    });
    expect(seen.noProxy).toContain("127.0.0.1");

    expect(JSON.parse((await skills.run(skill, [NODE, "-e", "console.log(JSON.stringify(process.cwd()))"], { cwd: "data" })).stdout_head)).toBe(path.join(folder, "data"));
    await expect(skills.run(skill, [NODE, "-e", ""], { cwd: "missing" })).rejects.toMatchObject({ code: "cwd_invalid", status: 422 });
    await expect(skills.run(skill, [NODE, "-e", ""], { cwd: "../.." })).rejects.toMatchObject({ code: "path_outside_skill" });

    // node 这个名字：用户装的或应用自带的都行
    expect((await skills.run(skill, ["node", "-e", "console.log(process.version)"])).stdout_head).toMatch(/^v\d+\./u);
  });

  it("refuses commands it cannot run safely", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);
    await expect(skills.run(skill, [])).rejects.toMatchObject({ code: "command_invalid", status: 400 });
    await expect(skills.run(skill, "node -v")).rejects.toMatchObject({ code: "command_invalid" });
    await expect(skills.run(skill, ["npm run build"])).rejects.toMatchObject({ code: "command_invalid", message: expect.stringContaining("[\"npm\",\"run\",\"build\"]") });
    await expect(skills.run(skill, ["definitely-not-a-command-dy2"])).rejects.toMatchObject({ code: "command_missing", status: 422 });
    await expect(skills.run(skill, ["../../outside.sh"])).rejects.toMatchObject({ code: "path_outside_skill" });
    await expect(skills.run(skill, ["./missing.sh"])).rejects.toMatchObject({ code: "command_missing" });
  });

  it("strips colors, decodes GBK and keeps the head and tail of long output", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);
    const colored = await skills.run(skill, [NODE, "-e", "process.stdout.write('\\u001b[31mred\\u001b[0m\\n'); process.stderr.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))"]);
    expect(colored.stdout_head).toBe("red\n");
    expect(colored.stderr_tail).toBe("中文");
    // 先来一段 GBK（cmd.exe 的报错），再来 UTF-8（node 的输出）：后面的照样按 UTF-8 解
    const mixed = await skills.run(skill, [NODE, "-e", "process.stderr.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])); setTimeout(() => process.stderr.write('张三'), 200)"]);
    expect(mixed.stderr_tail).toBe("中文\n张三");
    // GBK 的一个字被拆在两块里：第一块的半个字（UTF-8 看着也像半个字，先缓着）要拼回去一起按 GBK 解
    const split = await skills.run(skill, [NODE, "-e", "process.stderr.write(Buffer.from([0xd6])); setTimeout(() => process.stderr.write(Buffer.from([0xd0, 0xce, 0xc4])), 200)"]);
    expect(split.stderr_tail).toBe("中文");
    // UTF-8 的字拆在两块里照样接得上
    const utf8 = await skills.run(skill, [NODE, "-e", "const b = Buffer.from('张三'); process.stderr.write(b.subarray(0, 4)); setTimeout(() => process.stderr.write(b.subarray(4)), 200)"]);
    expect(utf8.stderr_tail).toBe("张三");
    // 已经在按 GBK 解、最后一个字被拆开：后半块只有一个 ≥0xC0 的字节，单看像没写完的 UTF-8，也要接着交给 GBK
    const half = await skills.run(skill, [NODE, "-e", "process.stderr.write(Buffer.from([0xce, 0xc4, 0xd6])); setTimeout(() => process.stderr.write(Buffer.from([0xd0])), 200)"]);
    expect(half.stderr_tail).toBe("文中");

    const long = await skills.run(skill, [NODE, "-e", "process.stdout.write('a'.repeat(3000) + 'b'.repeat(10000) + 'END')"]);
    expect(long.stdout_head).toBe("a".repeat(2_000));
    expect(long.stdout_tail).toHaveLength(8_000);
    expect(long.stdout_tail.endsWith("bEND")).toBe(true);
    expect(long.truncated).toBe(true);

    const short = await skills.run(skill, [NODE, "-e", "process.stdout.write('a'.repeat(2500))"]);
    expect(short).toMatchObject({ stdout_head: "a".repeat(2_000), stdout_tail: "a".repeat(500), truncated: false });
  });

  it("times out, stops on abort and reports the last output line", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);

    const slow = await skills.run(skill, [NODE, "-e", "console.log('start'); setInterval(() => {}, 1000)"], { timeoutMs: 1_500 });
    expect(slow).toMatchObject({ exit_code: null, timed_out: true });
    expect(slow.stdout_head).toContain("start");

    const pidFile = path.join(skill.work, "pid.txt");
    const controller = new AbortController();
    const running = skills.run(skill, [NODE, "-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { signal: controller.signal });
    await until(() => exists(pidFile));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    const pid = Number(await readFile(pidFile, "utf8"));
    await until(() => !alive(pid));

    const lines = [];
    await skills.run(skill, [NODE, "-e", "console.log('first'); setTimeout(() => console.log('second line'), 1300)"], { onOutput: (line) => lines.push(line) });
    expect(lines).toEqual(["first", "second line"]);
  });

  it("lists files the command changed, newest first, skipping dependencies", async () => {
    const { skills } = await manager();
    const { skill, folder } = await folderSkill(skills, { "out/old.txt": "old" });
    const old = path.join(folder, "out", "old.txt");
    await utimes(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const made = await skills.run(skill, [NODE, "-e", [
      "const fs = require('fs'); const path = require('path');",
      "fs.writeFileSync('out/new.txt', 'n');",
      "fs.mkdirSync('node_modules/z', { recursive: true }); fs.writeFileSync('node_modules/z/a.js', 'x');",
      "fs.writeFileSync(path.join(process.env.DY2_WORK_DIR, 'w.txt'), 'www');",
    ].join(" ")]);
    expect(made.exit_code).toBe(0);
    expect(made.new_files).toContainEqual({ path: path.join(folder, "out", "new.txt"), size: 1 });
    expect(made.new_files).toContainEqual({ path: path.join(skill.work, "w.txt"), size: 3 });
    const paths = made.new_files.map((file) => file.path);
    expect(paths).not.toContain(old);
    expect(paths.some((file) => file.includes("node_modules") || file.includes(".runs"))).toBe(false);
  });

  // Windows CI 上建两万个文件太慢（杀毒软件逐个扫）
  it.skipIf(windows)("still lists what the command wrote to the work folder when the package folder is huge", async () => {
    const { skills } = await manager();
    const { skill, folder } = await folderSkill(skills);
    for (let batch = 0; batch < 21; batch += 1) {
      await mkdir(path.join(folder, "samples", `b${batch}`), { recursive: true });
      await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(path.join(folder, "samples", `b${batch}`, `${index}.wav`), "")));
    }
    const made = await skills.run(skill, [NODE, "-e", "require('fs').writeFileSync(require('path').join(process.env.DY2_WORK_DIR, 'out.wav'), 'w')"]);
    expect(made.new_files).toContainEqual({ path: path.join(skill.work, "out.wav"), size: 1 });
  });

  it("runs background jobs that outlive the call until they exit or are stopped", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);

    const command = [NODE, "-e", "console.log('ready'); setInterval(() => {}, 1000)"];
    const started = await skills.run(skill, command, { background: true, signal: new AbortController().signal });
    expect(started).toEqual({ job_id: expect.stringMatching(/^[0-9a-f]{16}$/u), status: "running", log: path.join(skill.work, ".runs", `${started.job_id}.log`) });
    expect(await skills.jobs()).toEqual([{ job_id: started.job_id, skill: "runner", command, started_at: expect.any(String), status: "running" }]);
    await until(async () => (await skills.job(started.job_id)).stdout_tail.includes("ready"));
    expect(await skills.job(started.job_id, { waitMs: 200 })).toMatchObject({ status: "running", exit_code: null });
    expect(await skills.job(started.job_id, { stop: true })).toMatchObject({ status: "stopped" });
    expect(await skills.jobs()).toEqual([]);

    const quick = await skills.run(skill, [NODE, "-e", "setTimeout(() => { console.log('done'); process.exit(0) }, 200)"], { background: true });
    const finished = await skills.job(quick.job_id, { waitMs: 10_000 });
    expect(finished).toMatchObject({ status: "exited", exit_code: 0, new_files: expect.any(Array), log: quick.log });
    expect(Object.keys(finished)).toEqual(["job_id", "status", "exit_code", "log", "new_files", "stderr_tail", "stdout_tail"]);
    expect(finished.stdout_tail).toContain("done");
    await expect(skills.job("0000000000000000")).rejects.toMatchObject({ code: "job_not_found", status: 404 });
  });

  // 进程组是 posix 的；Windows 上命令退了，它起的进程管不到
  it.skipIf(windows)("leaves the output open for a service the command started and left running", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills, { "start.mjs": STARTER });
    const result = await skills.run(skill, [NODE, "start.mjs", "inherit", "fg"]);
    expect(result.exit_code).toBe(0);
    const pid = Number(await readFile(path.join(skill.work, "fg.pid"), "utf8"));
    cleanups.push(() => { try { process.kill(pid, "SIGKILL"); } catch { /* 已经退了 */ } });
    // 管道关了的话，它下一次打印就 EPIPE 崩掉
    await delay(1_500);
    expect(alive(pid)).toBe(true);
    expect(await readFile(result.log, "utf8")).toContain("tick");
  });

  it.skipIf(windows)("still lists and stops what a command left running after it exited, and kills it on close", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills, { "start.mjs": STARTER });
    const started = await skills.run(skill, [NODE, "start.mjs", "ignore", "bg"], { background: true });
    await until(async () => (await skills.job(started.job_id)).status === "exited");
    const pid = Number(await readFile(path.join(skill.work, "bg.pid"), "utf8"));
    cleanups.push(() => { try { process.kill(pid, "SIGKILL"); } catch { /* 已经退了 */ } });
    expect(await skills.jobs()).toEqual([expect.objectContaining({ job_id: started.job_id, status: "running", leftover: true })]);
    expect(await skills.job(started.job_id)).toMatchObject({ status: "exited", leftover: true });
    await expect(skills.remove(skill.id)).rejects.toMatchObject({ code: "skill_busy" });
    expect(await skills.job(started.job_id, { stop: true })).toMatchObject({ status: "stopped" });
    await until(() => !alive(pid));
    expect(await skills.jobs()).toEqual([]);

    // 前台跑的启动器留下的也算；关应用时连组杀掉
    const result = await skills.run(skill, [NODE, "start.mjs", "ignore", "fg"]);
    const left = Number(await readFile(path.join(skill.work, "fg.pid"), "utf8"));
    cleanups.push(() => { try { process.kill(left, "SIGKILL"); } catch { /* 已经退了 */ } });
    expect((await skills.jobs()).map((job) => job.job_id)).toEqual([result.job_id]);
    await skills.close();
    await until(() => !alive(left));
  });

  it("does not start a command when closing while it is still being set up", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // 装本机文件夹也要读用户环境：先用另一个管理器装好，卡住的只有跑命令这一步
    const { skills: setup, root } = await manager();
    const { skill } = await folderSkill(setup);
    const skills = createSkills({ root, shellEnv: async () => { await gate; return { ...process.env }; }, proxy: async () => null });
    cleanups.push(() => skills.close());
    const pidFile = path.join(skill.work, "late.pid");
    const pending = skills.run(skill, [NODE, "-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 3000)`], { background: true })
      .catch((error) => error);
    await delay(50);
    await skills.close();
    release();
    expect(await pending).toMatchObject({ code: "interrupted" });
    await delay(300);
    expect(await exists(pidFile)).toBe(false);
  });

  it("refuses to remove or replace a package while a foreground command runs in it", async () => {
    const zip = repoZip({ "Pack-main/SKILL.md": skillFile("pack", "包") });
    const { skills } = await manager({ fetchImpl: github(() => zip).fetchImpl });
    const [skill] = (await skills.install("https://github.com/me/pack")).installed;
    const started = path.join(skill.work, "started.txt");
    const running = skills.run(skill, [NODE, "-e", `require('fs').writeFileSync(${JSON.stringify(started)}, '1'); setTimeout(() => {}, 1500)`]);
    await until(() => exists(started));
    await expect(skills.remove(skill.id)).rejects.toMatchObject({ code: "skill_busy", status: 409 });
    await expect(skills.install("https://github.com/me/pack")).rejects.toMatchObject({ code: "skill_busy" });
    expect((await running).exit_code).toBe(0);
    expect(await skills.remove(skill.id)).toEqual({ removed: true });
  });

  it("allows four background jobs at a time and kills everything on close", async () => {
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);
    const pidFiles = [0, 1, 2, 3].map((index) => path.join(skill.work, `pid-${index}.txt`));
    for (const file of pidFiles) {
      await skills.run(skill, [NODE, "-e", `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`], { background: true });
    }
    await expect(skills.run(skill, [NODE, "-e", ""], { background: true })).rejects.toMatchObject({ code: "too_many_jobs", status: 409 });
    // 前台命令不占名额
    expect((await skills.run(skill, [NODE, "-e", "process.exit(0)"])).exit_code).toBe(0);
    await until(async () => (await Promise.all(pidFiles.map(exists))).every(Boolean));
    const pids = await Promise.all(pidFiles.map(async (file) => Number(await readFile(file, "utf8"))));
    await skills.close();
    await until(() => pids.every((pid) => !alive(pid)));
    await expect(skills.run(skill, [NODE, "-e", ""])).rejects.toMatchObject({ code: "interrupted" });
  });

  it("describes the computer once a minute", async () => {
    const { skills } = await manager();
    const environment = await skills.environment();
    expect(environment).toMatchObject({
      os: expect.any(String), shell: expect.any(String),
      node: { path: expect.any(String), version: expect.stringMatching(/^\d+\.\d+\.\d+/u), bundled: expect.any(Boolean) },
      npm: expect.any(Boolean),
    });
    for (const key of ["python", "ffmpeg", "chrome"]) expect(environment[key] === null || typeof environment[key] === "string").toBe(true);
    expect(await skills.environment()).toBe(environment);
  });

  it("runs the app itself as node and does not hand out its path when the computer has no Node", async () => {
    // 写成应用自己的路径也按 node 跑（桌面版里这就是应用本身，不加这个会再开一个应用）
    const { skills } = await manager();
    const { skill } = await folderSkill(skills);
    expect((await skills.run(skill, [process.execPath, "-e", "console.log(process.env.ELECTRON_RUN_AS_NODE ?? 'none')"])).stdout_head).toBe("1\n");

    const empty = await temporaryDirectory("no-node-");
    const bare = (await manager({ platform: "win32", home: empty, shellEnv: windowsShell([empty], empty) })).skills;
    expect((await bare.environment()).node).toMatchObject({ path: "node", version: process.versions.node, bundled: true, note: expect.stringContaining("node") });
  });

  it("finds npm through a version manager's exe shims on Windows", async () => {
    const shims = await temporaryDirectory("shims-");
    const empty = await temporaryDirectory("no-home-");
    // node.exe、npm.exe 都是 shim，旁边没有 node_modules
    await put(shims, { "node.exe": "", "npx.exe": "", "npm.exe": "#!/bin/sh\necho npm-shim \"$@\"\n" });
    await chmod(path.join(shims, "npm.exe"), 0o755);
    const { skills } = await manager({ platform: "win32", home: empty, shellEnv: windowsShell([shims], empty) });
    expect((await skills.environment()).npm).toBe(true);
    const { skill } = await folderSkill(skills);
    const outcome = await skills.run(skill, ["npm", "ci"]).catch((error) => error);
    expect(outcome.code).not.toBe("command_missing");
    // 假的 shim 只有 posix 上跑得起来
    if (!windows) expect(outcome.stdout_head).toBe("npm-shim ci\n");
  });

  it("on Windows uses the environment read afresh, not the one the app started with", async () => {
    const nodeDir = await temporaryDirectory("new-node-");
    const empty = await temporaryDirectory("no-home-");
    await put(nodeDir, { "node.exe": "", "node_modules/npm/bin/npm-cli.js": "" });
    const { skills } = await manager({ platform: "win32", home: empty, shellEnv: windowsShell([nodeDir], empty) });
    const environment = await skills.environment();
    expect(environment.node).toMatchObject({ path: path.join(nodeDir, "node.exe"), bundled: false });
    expect(environment.npm).toBe(true);
  });

  it("on Windows finds Node in Program Files when the Path does not list it", async () => {
    const programs = await temporaryDirectory("program-files-");
    const empty = await temporaryDirectory("no-home-");
    await put(programs, { "nodejs/node.exe": "", "nodejs/node_modules/npm/bin/npm-cli.js": "" });
    const found = path.join(programs, "nodejs", "node.exe");
    // 32 位应用里 ProgramFiles 指向 x86 那个，64 位的在 ProgramW6432
    for (const vars of [{ ProgramW6432: programs, ProgramFiles: empty }, { ProgramFiles: programs }]) {
      const { skills } = await manager({ platform: "win32", home: empty, shellEnv: async () => ({ PATH: empty, PATHEXT: ".EXE;.CMD", ...vars }) });
      const environment = await skills.environment();
      expect(environment.node, JSON.stringify(vars)).toMatchObject({ path: found, bundled: false });
      expect(environment.npm).toBe(true);
    }
  });

  it("looks for programs again right after one was not found", async () => {
    const tools = await temporaryDirectory("late-tool-");
    await put(tools, windows ? { "late-tool-dy2.cmd": "@echo found\r\n" } : { "late-tool-dy2": "#!/bin/sh\necho found\n" });
    if (!windows) await chmod(path.join(tools, "late-tool-dy2"), 0o755);
    const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    let extra = [];
    // 用户照提示装好了：环境里多了一个目录
    const { skills } = await manager({ shellEnv: async () => ({ ...process.env, [key]: [...extra, process.env[key]].join(path.delimiter) }) });
    const { skill } = await folderSkill(skills);
    await expect(skills.run(skill, ["late-tool-dy2"])).rejects.toMatchObject({ code: "command_missing" });
    extra = [tools];
    expect((await skills.run(skill, ["late-tool-dy2"])).stdout_head).toContain("found");
  });

  it.runIf(existsSync("/usr/bin/python3"))("does not report the macOS python placeholder when the command line tools are missing", async () => {
    const empty = await temporaryDirectory("no-tools-");
    const shellEnv = async () => ({ ...process.env, PATH: "/usr/bin:/bin" });
    const missing = (await manager({ platform: "darwin", home: empty, shellEnv, developerTools: async () => false })).skills;
    expect((await missing.environment()).python).not.toBe("/usr/bin/python3");
    const installed = (await manager({ platform: "darwin", home: empty, shellEnv, developerTools: async () => true })).skills;
    expect((await installed.environment()).python).toBe("/usr/bin/python3");
  });
});

describe("windowsEnv", () => {
  it("adds the Path folders the registry has now after the ones the app started with, expanding variables", async () => {
    const asked = [];
    const query = async (args) => {
      asked.push(args[1]);
      if (args[1].startsWith("HKLM")) return Buffer.from("\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Program Files\\nodejs\\\r\n\r\n");
      // 中文系统下 reg.exe 的输出是 GBK
      return Buffer.concat([Buffer.from("\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %userprofile%\\bin;C:\\Users\\"), Buffer.from([0xd5, 0xc5, 0xc8, 0xfd]), Buffer.from("\\Python\r\n\r\n")]);
    };
    const env = await windowsEnv({ env: { Path: "C:\\Windows\\system32;C:\\Tools", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\me" }, query });
    expect(env.Path).toBe("C:\\Windows\\system32;C:\\Tools;C:\\Program Files\\nodejs\\;C:\\Users\\me\\bin;C:\\Users\\张三\\Python");
    expect(asked).toEqual(["HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "HKCU\\Environment"]);
    // 读不到注册表：原样
    expect(await windowsEnv({ env: { PATH: "a;b" }, query: async () => null })).toEqual({ PATH: "a;b" });
  });

  it("adds the other variables set since the app started, the user's over the machine's, keeping the ones it already has", async () => {
    const query = async (args) => (args[1].startsWith("HKLM")
      ? Buffer.from("\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe\r\n    CODEX_HOME    REG_SZ    D:\\codex\r\n    Path    REG_EXPAND_SZ    C:\\Tools\r\n\r\n")
      : Buffer.from("\r\nHKEY_CURRENT_USER\\Environment\r\n    CLAUDE_CONFIG_DIR    REG_EXPAND_SZ    %USERPROFILE%\\claude\r\n    CODEX_HOME    REG_SZ    E:\\codex\r\n    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp\r\n    Path    REG_EXPAND_SZ    C:\\Bin\r\n\r\n"));
    const env = await windowsEnv({ env: { Path: "C:\\Tools", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\me", ComSpec: "C:\\cmd.exe", temp: "T:\\" }, query });
    // 应用开着时 setx 的变量补上（Path 照旧合并）；本进程有的（变量名不分大小写）不动
    expect(env).toEqual({
      Path: "C:\\Tools;C:\\Bin", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\me", ComSpec: "C:\\cmd.exe", temp: "T:\\",
      CODEX_HOME: "E:\\codex", CLAUDE_CONFIG_DIR: "C:\\Users\\me\\claude",
    });
  });
});
