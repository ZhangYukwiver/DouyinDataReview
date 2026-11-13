import { afterEach, expect, it, vi } from "vitest";
import { assistantConfigReady, loadAssistantConfig, saveAssistantConfig, sendAssistantMessage } from "./assistant";

afterEach(() => vi.unstubAllGlobals());

it("keeps WorkBuddy selected after reloading and sends no stored API credentials to the local runtime", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  saveAssistantConfig({ runtime: "workbuddy", baseUrl: "https://unused.example/v1", apiKey: "test-key-not-to-send", model: "  auto  " }, storage);
  const config = loadAssistantConfig(storage);
  expect(config.runtime).toBe("workbuddy");
  expect(assistantConfigReady(config)).toBe(true);
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ messages: [] }));
  vi.stubGlobal("fetch", fetch);
  await sendAssistantMessage({ baseUrl: "http://127.0.0.1:7777", token: "test-pairing-token" }, "在吗", config, null);
  const request = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
  expect(request.config).toEqual({ runtime: "workbuddy", model: "auto" });
  expect(JSON.stringify(request)).not.toContain("test-key-not-to-send");
});
