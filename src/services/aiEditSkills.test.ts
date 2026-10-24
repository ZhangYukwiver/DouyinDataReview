import { afterEach, describe, expect, it, vi } from "vitest";
import { toolsFor } from "../../collector/aiEdit/tools.mjs";
import { answerAiEditCommand, commandLine, installAiEditSkill, listAiEditSkills, removeAiEditSkill, SKILL_TOOLS, stopAiEditSkillJob, updateAiEditSkill } from "./aiEditSkills";

afterEach(() => { vi.unstubAllGlobals(); });

const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
const skill = {
  id: "demo", name: "demo", description: "示例技能", root: "/skills/pack", dir: "/skills/pack/demo", work: "/data/skill-work/demo",
  source: { type: "folder", path: "/skills/pack" }, enabled: true, trustCommands: false, installedAt: "2026-10-24T00:00:00.000Z", problem: null,
};

/** 记下每次请求的地址、方法和请求体，回 reply 给的那份 */
function stubCalls(reply: (url: string) => { status?: number; body: unknown }) {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const { status = 200, body } = reply(url);
    return Response.json(body, { status });
  }));
  return calls;
}

describe("技能设置", () => {
  it("读技能和后台命令；旧版采集器没有这个接口时回 null", async () => {
    const job = { job_id: "j1", skill: "demo", command: ["node", "serve.mjs"], started_at: "2026-10-24T00:00:00.000Z", status: "running" };
    let status = 200;
    const calls = stubCalls(() => (status === 200 ? { body: { skills: [skill], jobs: [job] } } : { status, body: { error: "not_found" } }));
    expect(await listAiEditSkills(connection)).toEqual({ skills: [skill], jobs: [job] });
    status = 404;
    expect(await listAiEditSkills(connection)).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["http://127.0.0.1:4765/v1/ai-edit/skills", "http://127.0.0.1:4765/v1/ai-edit/skills"]);
  });

  it("别的错误照常报出来", async () => {
    stubCalls(() => ({ status: 500, body: { error: "skills_broken", message: "登记表坏了。" } }));
    await expect(listAiEditSkills(connection)).rejects.toMatchObject({ code: "skills_broken", message: "登记表坏了。" });
  });

  it("装、改、删、停后台命令发到各自的地址上", async () => {
    const calls = stubCalls((url) => ({
      body: url.endsWith("/skills") ? { installed: [skill] } : url.includes("/jobs/") ? { job: { job_id: "j 1", status: "stopped" } } : url.endsWith("/demo%2F1") ? { skill: { ...skill, enabled: false } } : {},
    }));
    expect(await installAiEditSkill(connection, "https://github.com/someone/some-skills")).toEqual({ installed: [skill], skipped: [] });
    expect(await updateAiEditSkill(connection, "demo/1", { enabled: false })).toMatchObject({ enabled: false });
    await removeAiEditSkill(connection, "demo/1");
    await stopAiEditSkillJob(connection, "j 1");
    expect(calls).toEqual([
      { url: "http://127.0.0.1:4765/v1/ai-edit/skills", method: "POST", body: { source: "https://github.com/someone/some-skills" } },
      { url: "http://127.0.0.1:4765/v1/ai-edit/skills/demo%2F1", method: "PATCH", body: { enabled: false } },
      { url: "http://127.0.0.1:4765/v1/ai-edit/skills/demo%2F1", method: "DELETE", body: undefined },
      { url: "http://127.0.0.1:4765/v1/ai-edit/skills/jobs/j%201/stop", method: "POST", body: undefined },
    ]);
  });

  it("没装上：采集器的说明原样带出来", async () => {
    stubCalls(() => ({ status: 422, body: { error: "skill_missing", message: "这个地址里没有找到 SKILL.md。" } }));
    await expect(installAiEditSkill(connection, "/tmp/empty")).rejects.toMatchObject({ code: "skill_missing", message: "这个地址里没有找到 SKILL.md。" });
  });
});

describe("运行技能命令前的确认", () => {
  it("点的「运行」「不运行」和「以后不用问」发到这一问上", async () => {
    const calls = stubCalls(() => ({ body: { answered: true } }));
    await answerAiEditCommand(connection, "s", "0123456789abcdef", true, true);
    await answerAiEditCommand(connection, "s", "0123456789abcdef", false, false);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/command/0123456789abcdef", method: "POST", body: { allow: true, remember: true } },
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/command/0123456789abcdef", method: "POST", body: { allow: false, remember: false } },
    ]);
  });

  it("这一问已经结束：带着 404 的代号报错", async () => {
    stubCalls(() => ({ status: 404, body: { error: "spend_not_found", message: "这次确认已经结束了。" } }));
    await expect(answerAiEditCommand(connection, "s", "0123456789abcdef", true, false)).rejects.toMatchObject({ code: "spend_not_found", message: "这次确认已经结束了。" });
  });

  it("技能工具都算不动时间线：和采集器只在有启用的技能时才发的那几个一个不差", () => {
    const names = (skills: unknown[]) => toolsFor({ generation: null, skills }).map((tool) => tool.function.name);
    const always = new Set(names([]));
    expect([...SKILL_TOOLS].sort()).toEqual(names([{}]).filter((name) => !always.has(name)).sort());
  });

  it("命令拼成一行：带空格、引号、空的参数加引号，反斜杠不动", () => {
    expect(commandLine(["node", "scripts/render.mjs", "--out", "~work/a b.wav"])).toBe("node scripts/render.mjs --out \"~work/a b.wav\"");
    expect(commandLine(["C:\\Program Files\\nodejs\\node.exe", "-e", "console.log(\"hi\")", ""])).toBe("\"C:\\Program Files\\nodejs\\node.exe\" -e \"console.log(\\\"hi\\\")\" \"\"");
    expect(commandLine(["C:\\tools\\ffmpeg.exe", "-version"])).toBe("C:\\tools\\ffmpeg.exe -version");
  });
});
