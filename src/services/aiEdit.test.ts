import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAiEditConfig, sendAiEditMessage, setAiEditGoal } from "./aiEdit";

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
