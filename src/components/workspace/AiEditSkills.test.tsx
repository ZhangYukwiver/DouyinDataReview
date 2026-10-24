import { afterEach, describe, expect, it, vi } from "vitest";

// 用 RN-web 在 Node 里渲染成 HTML 看读屏名称和按钮上的字。没有 DOM，effect 不跑，看的是刚挂上（打开设置）那一下
// @ts-expect-error -- react-native-web 没给 .d.ts
vi.mock("react-native", async () => await import("react-native-web"));
vi.mock("lucide-react-native", () => ({ Check: () => null }));

import React from "react";
// @ts-expect-error -- 项目没装 @types/react-dom
import { renderToStaticMarkup as renderUntyped } from "react-dom/server";
import type { AiEditSkill, AiEditSkillJob } from "../../services/aiEditSkills";
import { shortTime } from "./aiEditShared";
import { JobRow, pollEvery, SkillRow, SkillsPanel, skillsLoader, startInstall } from "./AiEditSkills";

const renderToStaticMarkup = renderUntyped as (node: React.ReactNode) => string;

afterEach(() => { vi.unstubAllGlobals(); });

const skillOf = (id: string, name: string): AiEditSkill => ({
  id, name, description: "", root: `/skills/${id}`, dir: `/skills/${id}`, work: `/data/skill-work/${id}`,
  source: { type: "folder", path: `/skills/${id}` }, enabled: true, trustCommands: false, installedAt: "2026-10-24T00:00:00.000Z", problem: null,
});
const jobOf = (id: string, skill: string, startedAt: string, status: AiEditSkillJob["status"] = "running"): AiEditSkillJob =>
  ({ job_id: id, skill, command: ["node", "serve.mjs"], started_at: startedAt, status });
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1]);
const noop = () => undefined;

/** POST 装技能先挂着，等测试放行；GET 回空列表 */
function stubInstall() {
  const posts: string[] = [];
  let release: (response: Response) => void = noop;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== "POST") return Response.json({ skills: [], jobs: [] });
    posts.push(url);
    return new Promise<Response>((resolve) => { release = resolve; });
  }));
  return { posts, release: (response: Response) => release(response) };
}

describe("技能设置", () => {
  it("装了几个技能时，勾选框和停止按钮的读屏名称带上是哪个技能", () => {
    const html = renderToStaticMarkup(<>
      {[skillOf("a", "A"), skillOf("b", "B")].map((skill) => <SkillRow key={skill.id} skill={skill} shared={false} confirming={false}
        onPatch={noop} onAskRemove={noop} onRemove={noop} onCancelRemove={noop} />)}
      <JobRow job={jobOf("j1", "A", "2026-10-24T01:00:00.000Z")} stopping={false} onStop={noop} />
      <JobRow job={jobOf("j2", "A", "2026-10-24T02:30:00.000Z")} stopping={false} onStop={noop} />
    </>);
    const all = labels(html);
    expect(all).toEqual(expect.arrayContaining([
      "启用技能「A」", "技能「A」运行命令不用每次问", "启用技能「B」", "技能「B」运行命令不用每次问",
      `停止技能「A」${shortTime("2026-10-24T01:00:00.000Z")} 开始的后台命令`, `停止技能「A」${shortTime("2026-10-24T02:30:00.000Z")} 开始的后台命令`,
    ]));
    // 看得见的字不变；没有两个一样的读屏名称
    expect(html).toContain(">启用<");
    expect(html).toContain(">停止<");
    expect(new Set(all).size).toBe(all.length);
  });

  it("删 GitHub 装的技能前说清楚技能自己存的数据也会删；命令退了、留下的进程还在跑的写明白，也能停", () => {
    const github: AiEditSkill = { ...skillOf("a", "A"), source: { type: "github", url: "https://github.com/o/r", ref: null, subdir: null } };
    const html = renderToStaticMarkup(<>
      <SkillRow skill={github} shared={false} confirming onPatch={noop} onAskRemove={noop} onRemove={noop} onCancelRemove={noop} />
      <JobRow job={{ ...jobOf("j1", "A", "2026-10-24T01:00:00.000Z"), leftover: true }} stopping={false} onStop={noop} />
    </>);
    expect(html).toContain("技能自己存在里面的数据");
    expect(html).toContain("命令已退出，它起的进程还在跑");
    expect(html).toContain(">停止<");
  });

  it("安装中收起设置再打开：接着显示「安装中…」，再点也不会装第二次，结果留到下次打开", async () => {
    const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
    const { posts, release } = stubInstall();
    const run = startInstall(connection, "https://github.com/someone/some-skills");
    expect(run).toMatchObject({ pending: true });
    // 面板卸载再挂上：按钮还是「安装中…」，再装一次不发请求
    const html = renderToStaticMarkup(<SkillsPanel connection={connection} />);
    expect(html).toContain("安装中…");
    expect(startInstall(connection, "https://github.com/someone/some-skills")).toBeNull();
    expect(posts).toHaveLength(1);
    // 别的采集器不受影响
    expect(renderToStaticMarkup(<SkillsPanel connection={{ baseUrl: "http://127.0.0.1:4766", token: "t" }} />)).not.toContain("安装中…");

    release(Response.json({ installed: [skillOf("a", "A")] }));
    await run?.done;
    expect(run).toMatchObject({ pending: false, problem: null });
    expect(run?.note).toContain("「A」");
    expect(renderToStaticMarkup(<SkillsPanel connection={connection} />)).not.toContain("安装中…");
    expect(startInstall(connection, "https://github.com/someone/other-skills")).not.toBeNull();
  });

  it("没装上：采集器说的原因记在这一次上，面板关着也不丢", async () => {
    const connection = { baseUrl: "http://127.0.0.1:4767", token: "t" };
    const { release } = stubInstall();
    const run = startInstall(connection, "/tmp/empty");
    release(Response.json({ error: "skill_missing", message: "这个地址里没有找到 SKILL.md。" }, { status: 422 }));
    await run?.done;
    expect(run).toMatchObject({ pending: false, note: null, problem: "这个地址里没有找到 SKILL.md。" });
  });

  it("设置开着就一直重读列表：没有后台命令也 15 秒看一次，有在跑的 5 秒；采集器没有技能功能不读", () => {
    expect(pollEvery({ skills: [], jobs: [] })).toBe(15000);
    expect(pollEvery({ skills: [], jobs: [jobOf("j1", "A", "2026-10-24T01:00:00.000Z", "exited")] })).toBe(15000);
    expect(pollEvery({ skills: [], jobs: [jobOf("j1", "A", "2026-10-24T01:00:00.000Z")] })).toBe(5000);
    // 第一次没读到也接着试
    expect(pollEvery(null)).toBe(15000);
    expect(pollEvery("old")).toBeNull();
  });

  it("读列表时又改、删、停了或者又读了一次，先发的那次回来就丢掉；上一次没回来，轮询不再发", async () => {
    const connection = { baseUrl: "http://127.0.0.1:4768", token: "t" };
    // 每个 GET 先挂着，按顺序由测试放行
    const replies: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { replies.push(resolve); }));
    vi.stubGlobal("fetch", fetchMock);
    const reply = (index: number, response: Response) => {
      const send = replies[index];
      if (!send) throw new Error(`第 ${index + 1} 次读列表没发出去`);
      send(response);
    };
    const onList = vi.fn();
    const onProblem = vi.fn();
    const loader = skillsLoader(onList, onProblem);
    const listOf = (...names: string[]) => Response.json({ skills: names.map((name) => skillOf(name, name)), jobs: [] });

    // 读的时候拨了开关：旧的那份不要
    const first = loader.load(connection);
    loader.bump();
    reply(0, listOf("Z"));
    await first;
    expect(onList).not.toHaveBeenCalled();

    // 上一次还在路上，轮询不叠着发；回来了才接着读
    const second = loader.load(connection);
    const skipped = loader.poll(connection);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await skipped;
    reply(1, listOf("A"));
    await second;
    expect(onList).toHaveBeenLastCalledWith({ skills: [skillOf("A", "A")], jobs: [] });
    const third = loader.poll(connection);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 又读了一次（点了重试、停完重读）：先发的后回来也不盖掉新的，没读到的原因也不报
    const fourth = loader.load(connection);
    reply(3, listOf("B"));
    await fourth;
    reply(2, Response.json({ error: "busy", message: "采集器忙" }, { status: 500 }));
    await third;
    expect(onList).toHaveBeenCalledTimes(2);
    expect(onList).toHaveBeenLastCalledWith({ skills: [skillOf("B", "B")], jobs: [] });
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("改、删、停在路上时轮询发出去的读，等它们做完才回来也丢掉：可能还是改之前的列表", async () => {
    const connection = { baseUrl: "http://127.0.0.1:4769", token: "t" };
    const replies: ((response: Response) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { replies.push(resolve); })));
    const onList = vi.fn();
    const loader = skillsLoader(onList, vi.fn());
    let finish: () => void = noop;
    // 删技能的请求还没回来，这时到点轮询了一次
    const removing = loader.guard(() => new Promise<void>((resolve) => { finish = resolve; }));
    const during = loader.poll(connection);
    finish();
    await removing;
    // 那次读确实发出去了
    expect(replies).toHaveLength(1);
    replies[0]?.(Response.json({ skills: [skillOf("A", "A")], jobs: [] }));
    await during;
    expect(onList).not.toHaveBeenCalled();
    // 做完以后再读的照常用；请求失败也一样作废、照样往外抛
    await expect(loader.guard(async () => { throw new Error("没删掉"); })).rejects.toThrow("没删掉");
    const after = loader.load(connection);
    expect(replies).toHaveLength(2);
    replies[1]?.(Response.json({ skills: [], jobs: [] }));
    await after;
    expect(onList).toHaveBeenCalledWith({ skills: [], jobs: [] });
  });

  it("装的时候跳过了几条（链到范围太大的文件夹）：装好的提示后面接着说明", async () => {
    const connection = { baseUrl: "http://127.0.0.1:4770", token: "t" };
    const { release } = stubInstall();
    const run = startInstall(connection, "/Users/me/.claude/skills");
    release(Response.json({ installed: [skillOf("a", "A")], skipped: ["「/Users/me/.claude/skills/all」链到的文件夹范围太大，没装。"] }));
    await run?.done;
    expect(run?.note).toContain("「A」");
    expect(run?.note).toContain("链到的文件夹范围太大，没装。");
  });
});
