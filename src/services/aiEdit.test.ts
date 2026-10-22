import { afterEach, describe, expect, it, vi } from "vitest";
import { aiConfigReady, editAiEditClip, editAiEditClips, exportAiEditSession, getAiRuntimes, loadAiEditConfig, redoAiEdit, revertAiEdit, saveAiEditConfig, sendAiEditMessage, setAiEditGoal, undoAiEdit } from "./aiEdit";

afterEach(() => { vi.unstubAllGlobals(); });

describe("sendAiEditMessage", () => {
  it("sends only the AI edit settings, never the video analysis ones", async () => {
    const saved = new Map<string, string>([["content-insights.analysis", "on"], ["dy2.analysisConfig", JSON.stringify({ apiKey: "analysis-key", direction: "美食" })]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ session: { id: "s" } }, { status: 202 });
    }));
    const config = { baseUrl: "https://edit.example.com/v1", apiKey: "edit-key", model: "m" };

    await sendAiEditMessage({ baseUrl: "http://127.0.0.1:4765", token: "t" }, "s", "参考同款", config);

    expect(bodies).toEqual([{ text: "参考同款", config }]);
  });

  it("带上画面上框的那一块", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ session: { id: "s" } }, { status: 202 });
    }));
    const config = { baseUrl: "https://edit.example.com/v1", apiKey: "edit-key", model: "m" };
    const region = { time_us: 3_200_000, x: 0.1, y: 0.05, width: 0.3, height: 0.25, clip_ids: ["c1"] };
    await sendAiEditMessage({ baseUrl: "http://127.0.0.1:4765", token: "t" }, "s", "这里换个颜色", config, region);
    expect(bodies).toEqual([{ text: "这里换个颜色", config, region }]);
  });
});

describe("看板上手动剪、撤销、退回", () => {
  const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
  const stubCalls = () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json({ session: { id: "s", revision: 2 }, project: { id: "p", revision: 3 } });
    }));
    return calls;
  };

  it("手动改动按工具名和参数发过去，拿回会话和工程", async () => {
    const calls = stubCalls();
    const state = await editAiEditClip(connection, "s", "move_clip", { clip_id: "c1", start: 3.2 });
    expect(calls).toEqual([{ url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/edit", method: "POST", body: { name: "move_clip", arguments: { clip_id: "c1", start: 3.2 } } }]);
    expect(state.project.revision).toBe(3);
  });

  it("一批改动一次发过去", async () => {
    const calls = stubCalls();
    const edits = [{ name: "delete_clip" as const, arguments: { clip_id: "c1" } }, { name: "delete_clip" as const, arguments: { clip_id: "c2" } }];
    await editAiEditClips(connection, "s", edits);
    expect(calls).toEqual([{ url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/edit", method: "POST", body: { edits } }]);
  });

  it("批量改动有一条没做成：带着第几步的说明报错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "timeline_overlap", message: "第 2 步没做成：和旁边的片段重叠了。" }, { status: 422 })));
    await expect(editAiEditClips(connection, "s", [{ name: "move_clip", arguments: { clip_id: "c1", start: 1 } }, { name: "move_clip", arguments: { clip_id: "c2", start: 1 } }]))
      .rejects.toMatchObject({ code: "timeline_overlap", message: "第 2 步没做成：和旁边的片段重叠了。" });
  });

  it("撤销、撤到历史里某一步之前、重做、退回到某句话之前", async () => {
    const calls = stubCalls();
    await undoAiEdit(connection, "s");
    await undoAiEdit(connection, "s", "cp3");
    await redoAiEdit(connection, "s");
    await revertAiEdit(connection, "s", "m1");
    expect(calls).toEqual([
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/undo", method: "POST", body: {} },
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/undo", method: "POST", body: { to: "cp3" } },
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/redo", method: "POST", body: {} },
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/revert", method: "POST", body: { messageId: "m1" } },
    ]);
  });

  it("没有能重做的：采集器的说明原样带出来", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "nothing_to_redo", message: "没有能重做的改动了。" }, { status: 409 })));
    await expect(redoAiEdit(connection, "s")).rejects.toMatchObject({ code: "nothing_to_redo", message: "没有能重做的改动了。" });
  });

  it("导入剪映时带上选的方式，没选就不带", async () => {
    const calls = stubCalls();
    await exportAiEditSession(connection, "s");
    await exportAiEditSession(connection, "s", "new");
    expect(calls.map((call) => call.body)).toEqual([{}, { mode: "new" }]);
  });

  it("草稿在剪映里被改过时报 draft_changed，带着中文说明", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "draft_changed", message: "剪映里的「旅行」在上次导入后被打开或改过。" }, { status: 409 })));
    await expect(exportAiEditSession(connection, "s")).rejects.toMatchObject({ code: "draft_changed", message: "剪映里的「旅行」在上次导入后被打开或改过。" });
  });
});

describe("setAiEditGoal", () => {
  it("posts the goal to the session and returns the updated session", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json({ session: { id: "s", goal: "30 秒快闪" } });
    }));
    const session = await setAiEditGoal({ baseUrl: "http://127.0.0.1:4765", token: "t" }, "s", "30 秒快闪");
    expect(calls).toEqual([{ url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/goal", method: "POST", body: { goal: "30 秒快闪" } }]);
    expect(session.goal).toBe("30 秒快闪");
  });
});

describe("loadAiEditConfig", () => {
  it("keeps the video check only for the model it was run on", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
    const base = { baseUrl: "https://relay.example.com/v1", apiKey: "k", model: "gpt-6.1-sol" };
    saved.set("dy2.aiEditConfig", JSON.stringify({ ...base, videoInput: false, videoProbe: "https://relay.example.com/v1|gpt-6.1-sol" }));
    expect(loadAiEditConfig()).toEqual({ ...base, videoInput: false, videoProbe: "https://relay.example.com/v1|gpt-6.1-sol" });
    saved.set("dy2.aiEditConfig", JSON.stringify({ ...base, model: "doubao-seed-2-1-lite-260915", videoInput: false, videoProbe: "https://relay.example.com/v1|gpt-6.1-sol" }));
    expect(loadAiEditConfig()).toEqual({ ...base, model: "doubao-seed-2-1-lite-260915" });
  });
});

describe("local Codex / Claude Code settings", () => {
  const stubStorage = () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
    return saved;
  };
  const api = { baseUrl: "https://edit.example.com/v1", apiKey: "edit-key", model: "doubao-seed-2-1-lite-260915" };

  it("keeps the chosen runtime and its own model across saves, and reads old settings as before", () => {
    const saved = stubStorage();
    saved.set("dy2.aiEditConfig", JSON.stringify(api));
    expect(loadAiEditConfig()).toEqual(api);
    saveAiEditConfig({ ...api, runtime: "codex", localModels: { codex: "gpt-6.1-sol", claude: 3 as unknown as string } });
    expect(loadAiEditConfig()).toEqual({ ...api, runtime: "codex", localModels: { codex: "gpt-6.1-sol" } });
    saved.set("dy2.aiEditConfig", JSON.stringify({ ...api, runtime: "ollama" }));
    expect(loadAiEditConfig().runtime).toBe("api");
  });

  it("is ready without a key only for a local runtime", () => {
    expect(aiConfigReady({ ...api, apiKey: "", runtime: "claude" })).toBe(true);
    expect(aiConfigReady({ ...api, apiKey: "" })).toBe(false);
    expect(aiConfigReady({ ...api, runtime: "api" })).toBe(true);
  });

  it("sends only the runtime and the local model, never the stored key", async () => {
    stubStorage();
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ session: { id: "s" } }, { status: 202 });
    }));
    const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
    await sendAiEditMessage(connection, "s", "剪", { ...api, runtime: "claude", localModels: { codex: "gpt-6.1-sol", claude: " sonnet " } });
    await sendAiEditMessage(connection, "s", "剪", { ...api, runtime: "codex" });
    await sendAiEditMessage(connection, "s", "剪", { ...api, runtime: "api", videoInput: false, videoProbe: "x" });
    expect(bodies).toEqual([
      { text: "剪", config: { runtime: "claude", model: "sonnet" } },
      { text: "剪", config: { runtime: "codex", model: "" } },
      { text: "剪", config: { ...api, videoInput: false } },
    ]);
  });

  it("reads the local runtime status, and says nothing when an older collector lacks it", async () => {
    const urls: string[] = [];
    let status = 200;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json(status === 200 ? { runtimes: [{ id: "codex", label: "Codex", state: "ready", version: "0.161.0", message: "好了" }] } : { error: "not_found" }, { status });
    }));
    const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
    expect(await getAiRuntimes(connection, true)).toEqual([{ id: "codex", label: "Codex", state: "ready", version: "0.161.0", message: "好了" }]);
    status = 404;
    expect(await getAiRuntimes(connection)).toBeNull();
    expect(urls).toEqual(["http://127.0.0.1:4765/v1/ai-edit/runtimes?fresh=1", "http://127.0.0.1:4765/v1/ai-edit/runtimes"]);
  });
});
