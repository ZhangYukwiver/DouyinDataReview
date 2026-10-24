import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AI_EDIT_GENERATE_CONFIG, aiConfigReady, answerAiEditSpend, borrowArkKey, editAiEditClip, editAiEditClips, exportAiEditSession, generateConfigProblem, generationForRequest, getAiRuntimes, isArkUrl,
  keepValidGenerateUrls, loadAiEditConfig, loadAiEditGenerateConfig, redoAiEdit, revertAiEdit, saveAiEditConfig, saveAiEditGenerateConfig, sendAiEditMessage, setAiEditGoal, undoAiEdit,
} from "./aiEdit";

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
    await sendAiEditMessage({ baseUrl: "http://127.0.0.1:4765", token: "t" }, "s", "这里换个颜色", config, { region });
    expect(bodies).toEqual([{ text: "这里换个颜色", config, region }]);
  });

  it("带上引用和附图，空的不发", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ session: { id: "s" } }, { status: 202 });
    }));
    const config = { baseUrl: "https://edit.example.com/v1", apiKey: "edit-key", model: "m" };
    const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
    const refs = [{ kind: "clip" as const, clip_id: "c1" }, { kind: "time" as const, time_us: 3_200_000 }, { kind: "media" as const, media_id: "m1" }];
    const attachments = [{ media_id: "m2", preview: "data:image/jpeg;base64,AAAA" }];
    await sendAiEditMessage(connection, "s", "这段换成这张图", config, { refs, attachments });
    await sendAiEditMessage(connection, "s", "剪", config, { region: null, refs: [], attachments: [] });
    expect(bodies).toEqual([{ text: "这段换成这张图", config, refs, attachments }, { text: "剪", config }]);
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

describe("生成图片和视频", () => {
  const connection = { baseUrl: "http://127.0.0.1:4765", token: "t" };
  const stubStorage = () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
    return saved;
  };
  const blank = (): typeof DEFAULT_AI_EDIT_GENERATE_CONFIG => structuredClone(DEFAULT_AI_EDIT_GENERATE_CONFIG);
  const ark = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "ark-edit", model: "doubao-seed-2-1-lite-260915" };
  const analysis = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "ark-analysis", model: "doubao-seed-2-1-lite-260915" };

  it("配了才随消息带上，没配时请求体和原来一样", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ session: { id: "s" } }, { status: 202 });
    }));
    const config = { baseUrl: "https://edit.example.com/v1", apiKey: "edit-key", model: "m" };
    const generation = { image: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-image", model: "gpt-image-2.5-flare" } };
    await sendAiEditMessage(connection, "s", "做张封面", config, { generation });
    await sendAiEditMessage(connection, "s", "剪", config, { generation: undefined });
    await sendAiEditMessage(connection, "s", "剪", config, { generation: {} });
    expect(bodies).toEqual([{ text: "做张封面", config, generation }, { text: "剪", config }, { text: "剪", config }]);
  });

  it("本机 Codex / Claude 模式下照样带得过去，和 config 平级", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ session: { id: "s" } }, { status: 202 });
    }));
    const generation = { video: { provider: "seedance" as const, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "ark-video", model: "doubao-seedance-2-0-260128" } };
    await sendAiEditMessage(connection, "s", "生成一段海浪", { ...ark, runtime: "codex" }, { generation });
    expect(bodies).toEqual([{ text: "生成一段海浪", config: { runtime: "codex", model: "" }, generation }]);
  });

  it("只带填了 Key 的那项，地址和模型留空用默认", () => {
    const generate = blank();
    expect(generationForRequest(generate, { ...ark, apiKey: "" })).toBeUndefined();
    generate.image = { baseUrl: " ", apiKey: " sk-image ", model: "" };
    expect(generationForRequest(generate, { ...ark, apiKey: "" })).toEqual({ image: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-image", model: "gpt-image-2.5-flare" } });
    generate.video = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3/", apiKey: "ark-video", model: " doubao-seedance-2-5-260628 ", borrow: false };
    expect(generationForRequest(generate, ark)?.video).toEqual({ provider: "seedance", baseUrl: "https://ark.cn-beijing.volces.com/api/v3/", apiKey: "ark-video", model: "doubao-seedance-2-5-260628" });
  });

  it("视频 Key 留空、没勾借 Key：不生成视频，哪怕 AI 剪辑和解析库都填了方舟 Key", () => {
    const generate = blank();
    expect(DEFAULT_AI_EDIT_GENERATE_CONFIG.video.borrow).toBe(false);
    expect(generationForRequest(generate, ark, analysis)).toBeUndefined();
    expect(generationForRequest(generate, { ...ark, runtime: "codex" }, analysis)).toBeUndefined();
    // 图片填了 Key 照样带图片，视频还是不带
    generate.image.apiKey = "sk-image";
    expect(generationForRequest(generate, ark, analysis)).toEqual({ image: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-image", model: "gpt-image-2.5-flare" } });
    // 自己填了视频 Key 就不用勾
    generate.video.apiKey = " own ";
    expect(generationForRequest(generate, ark, analysis)?.video).toEqual({ provider: "seedance", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "own", model: "doubao-seedance-2-0-260128" });
  });

  it("勾了借 Key、视频 Key 留空：先借 AI 剪辑的方舟 Key，再借解析库的", () => {
    const generate = blank();
    generate.video.borrow = true;
    const video = (apiKey: string) => ({ video: { provider: "seedance", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey, model: "doubao-seedance-2-0-260128" } });
    expect(generationForRequest(generate, ark, analysis)).toEqual(video("ark-edit"));
    // AI 剪辑接的不是方舟、或者选了本机 Codex：轮到解析库的
    expect(generationForRequest(generate, { ...ark, baseUrl: "https://relay.example.com/v1" }, analysis)).toEqual(video("ark-analysis"));
    expect(generationForRequest(generate, { ...ark, runtime: "codex" }, analysis)).toEqual(video("ark-analysis"));
    // 解析库也选了本机的、或者 Key 没填：不借，也就不带视频
    expect(generationForRequest(generate, { ...ark, runtime: "claude" }, { ...analysis, runtime: "codex" })).toBeUndefined();
    expect(generationForRequest(generate, { ...ark, apiKey: " " }, { ...analysis, apiKey: "" })).toBeUndefined();
    // 自己填了就用自己的
    generate.video.apiKey = "own";
    expect(generationForRequest(generate, ark, analysis)).toEqual(video("own"));
  });

  it("视频地址不是方舟时不借方舟 Key，免得发给别家", () => {
    const generate = blank();
    generate.video.borrow = true;
    generate.video.baseUrl = "https://relay.example.com/api/v3";
    expect(generationForRequest(generate, ark, analysis)).toBeUndefined();
    // 长得像但不是 volces.com 的也不算
    expect(isArkUrl("https://volces.com.example.com/api/v3")).toBe(false);
    expect(isArkUrl("https://evilvolces.com/api/v3")).toBe(false);
    expect(isArkUrl("ark.cn-beijing.volces.com/api/v3")).toBe(false);
    expect(isArkUrl("https://ARK.cn-beijing.volces.com/api/v3")).toBe(true);
    expect(borrowArkKey({ ...ark, baseUrl: "https://evilvolces.com/api/v3" }, null)).toBeNull();
    expect(borrowArkKey(ark, analysis)).toEqual({ from: "edit", apiKey: "ark-edit" });
    // 解析库存的东西被改坏了也不出错
    expect(borrowArkKey({ ...ark, apiKey: "" }, { baseUrl: analysis.baseUrl, apiKey: 3 })).toBeNull();
  });

  it("视频按选的那家带，带上是哪家；选的那家没连上就不带", () => {
    const generate = blank();
    generate.jimeng = { ...generate.jimeng, apiKey: " AKLT-id ", secretKey: "" };
    generate.libtv.apiKey = "lib-key";
    generate.use.video = "jimeng";
    // 即梦两把都要填
    expect(generationForRequest(generate, ark)).toBeUndefined();
    generate.jimeng.secretKey = " secret ";
    expect(generationForRequest(generate, ark)?.video).toEqual({ provider: "jimeng", baseUrl: DEFAULT_AI_EDIT_GENERATE_CONFIG.jimeng.baseUrl, apiKey: "AKLT-id", secretKey: "secret", model: DEFAULT_AI_EDIT_GENERATE_CONFIG.jimeng.model });
    generate.use.video = "libtv";
    expect(generationForRequest(generate, ark)?.video).toMatchObject({ provider: "libtv", apiKey: "lib-key" });
    expect(generationForRequest(generate, ark)?.video).not.toHaveProperty("secretKey");
    // 选了不生成：哪怕 Key 都填了也不带；图片同理
    generate.use.video = null;
    generate.image.apiKey = "sk-image";
    generate.use.image = null;
    expect(generationForRequest(generate, ark)).toBeUndefined();
  });

  it("老配置没有 use：图片照旧、视频走方舟；存的 use 认不出就退回方舟，存的 null 照读", () => {
    const saved = stubStorage();
    saved.set("dy2.aiEditGenerateConfig", JSON.stringify({ image: { apiKey: "sk" }, video: { apiKey: "ark" } }));
    expect(loadAiEditGenerateConfig().use).toEqual({ image: "openai", video: "seedance" });
    saved.set("dy2.aiEditGenerateConfig", JSON.stringify({ use: { image: null, video: "kling" } }));
    expect(loadAiEditGenerateConfig().use).toEqual({ image: null, video: "seedance" });
    saved.set("dy2.aiEditGenerateConfig", JSON.stringify({ use: { video: null }, jimeng: { apiKey: "a", secretKey: "b" } }));
    expect(loadAiEditGenerateConfig()).toMatchObject({ use: { image: "openai", video: null }, jimeng: { apiKey: "a", secretKey: "b" } });
  });

  it("存在本机，按字段读回来，坏的字段退回默认", () => {
    const saved = stubStorage();
    expect(loadAiEditGenerateConfig()).toEqual(DEFAULT_AI_EDIT_GENERATE_CONFIG);
    const generate = blank();
    generate.image.apiKey = "sk-image";
    generate.video.model = "doubao-seedance-2-0-fast-260128";
    saveAiEditGenerateConfig(generate);
    expect(JSON.parse(saved.get("dy2.aiEditGenerateConfig") ?? "null")).toEqual(generate);
    expect(loadAiEditGenerateConfig()).toEqual(generate);
    saved.set("dy2.aiEditGenerateConfig", JSON.stringify({ image: { apiKey: 5, model: "gpt-image-2" }, video: "x" }));
    expect(loadAiEditGenerateConfig()).toEqual({ ...DEFAULT_AI_EDIT_GENERATE_CONFIG, image: { ...DEFAULT_AI_EDIT_GENERATE_CONFIG.image, model: "gpt-image-2" } });
    saved.set("dy2.aiEditGenerateConfig", "{坏");
    expect(loadAiEditGenerateConfig()).toEqual(DEFAULT_AI_EDIT_GENERATE_CONFIG);
  });

  it("借 Key 的勾存得住；没有这一项的老配置、存坏了的都算没勾", () => {
    const saved = stubStorage();
    const generate = blank();
    generate.video.borrow = true;
    saveAiEditGenerateConfig(generate);
    expect(loadAiEditGenerateConfig().video.borrow).toBe(true);
    // 加这个勾之前存的：Key 和模型照旧读回来，借 Key 是不勾
    saved.set("dy2.aiEditGenerateConfig", JSON.stringify({ image: { baseUrl: "", apiKey: "", model: "" }, video: { baseUrl: "", apiKey: "", model: "doubao-seedance-2-0-fast-260128" } }));
    const old = loadAiEditGenerateConfig();
    expect(old.video).toEqual({ baseUrl: "", apiKey: "", model: "doubao-seedance-2-0-fast-260128", borrow: false });
    expect(generationForRequest(old, ark, analysis)).toBeUndefined();
    for (const borrow of ["true", 1, null]) {
      saved.set("dy2.aiEditGenerateConfig", JSON.stringify({ video: { borrow } }));
      expect(loadAiEditGenerateConfig().video.borrow).toBe(false);
    }
  });

  it("保存前查接口地址：留空或 http(s):// 开头才行", () => {
    const generate = blank();
    expect(generateConfigProblem(generate)).toBeNull();
    generate.image.baseUrl = " ";
    generate.video.baseUrl = "";
    expect(generateConfigProblem(generate)).toBeNull();
    generate.image.baseUrl = " http://127.0.0.1:8000/v1 ";
    expect(generateConfigProblem(generate)).toBeNull();
    generate.image.baseUrl = "api.openai.com/v1";
    expect(generateConfigProblem(generate)).toMatch(/^OpenAI 的接口地址要以 https:\/\/ 开头/u);
    generate.image.baseUrl = "";
    generate.video.baseUrl = "ftp://ark.cn-beijing.volces.com/api/v3";
    expect(generateConfigProblem(generate)).toMatch(/^火山方舟 Seedance 的接口地址要以 https:\/\/ 开头/u);
  });

  it("收起时替用户存：填错的地址退回原来的，Key、模型、借 Key 照存", () => {
    const stored = blank();
    stored.video.baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
    const draft = blank();
    draft.image = { baseUrl: "api.openai.com/v1", apiKey: "sk-image", model: "gpt-image-2" };
    draft.video = { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "ark-video", model: "doubao-seedance-2-0-fast-260128", borrow: true };
    const kept = keepValidGenerateUrls(draft, stored);
    expect(kept.config).toEqual({ ...draft, image: { baseUrl: stored.image.baseUrl, apiKey: "sk-image", model: "gpt-image-2" } });
    expect(generateConfigProblem(kept.config)).toBeNull();
    expect(kept.problem).toBe("OpenAI 的接口地址要以 https:// 开头，刚才填的没存，还用原来的。");
    // 两项都填错：两项都退回；原来存的也是坏的（老版本存下的）就留空用默认
    draft.video.baseUrl = "ark.cn-beijing.volces.com";
    stored.image.baseUrl = "坏地址";
    const both = keepValidGenerateUrls(draft, stored);
    expect([both.config.image.baseUrl, both.config.video.baseUrl]).toEqual(["", "https://ark.cn-beijing.volces.com/api/v3"]);
    expect(both.config.video).toMatchObject({ apiKey: "ark-video", borrow: true });
    expect(both.problem).toMatch(/^OpenAI、火山方舟 Seedance 的接口地址/u);
    // 都合格：原样不动
    expect(keepValidGenerateUrls(blank(), stored)).toEqual({ config: blank(), problem: null });
  });

  it("确认卡片上点的「生成」「不生成」发到这一问上", async () => {
    const calls: { url: string; method?: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json({ answered: true });
    }));
    await answerAiEditSpend(connection, "s", "0123456789abcdef", true);
    await answerAiEditSpend(connection, "s", "0123456789abcdef", false);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/spend/0123456789abcdef", method: "POST", body: { allow: true } },
      { url: "http://127.0.0.1:4765/v1/ai-edit/sessions/s/spend/0123456789abcdef", method: "POST", body: { allow: false } },
    ]);
  });

  it("这一问已经结束：带着 spend_not_found 报错（两种错误写法都认）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "spend_not_found", message: "这次确认已经结束了。" }, { status: 404 })));
    await expect(answerAiEditSpend(connection, "s", "0123456789abcdef", true)).rejects.toMatchObject({ code: "spend_not_found", message: "这次确认已经结束了。" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "spend_not_found", message: "这次确认已经结束了。" } }, { status: 404 })));
    await expect(answerAiEditSpend(connection, "s", "0123456789abcdef", true)).rejects.toMatchObject({ code: "spend_not_found", message: "这次确认已经结束了。" });
  });
});
