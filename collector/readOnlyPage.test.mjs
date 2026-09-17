import { afterEach, expect, it, vi } from "vitest";
import { pageNeedsVerification, prepareReadOnlyPage } from "./readOnlyPage.mjs";

afterEach(() => vi.unstubAllGlobals());

it("prevents script and attribute autoplay while metadata tabs remain readable", async () => {
  const started = vi.fn();
  class Media {
    play() { started(); }
    pause = vi.fn();
    removeAttribute = vi.fn();
  }
  let playListener, mutation;
  vi.stubGlobal("HTMLMediaElement", Media);
  const inserted = new Media();
  vi.stubGlobal("document", {
    addEventListener: (_event, callback) => { playListener = callback; },
    querySelectorAll: () => [inserted],
  });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback) { mutation = callback; }
    observe() {}
  });
  let paused;
  const network = { on: (_event, callback) => { paused = callback; }, send: vi.fn(async () => {}) };
  await prepareReadOnlyPage({ context: () => ({ newCDPSession: async () => network }), addInitScript: async (script) => script() });
  expect(network.send).toHaveBeenCalledWith("Fetch.enable", { patterns: [
    { urlPattern: "https://www.douyin.com/aweme/v1/web/history/*", requestStage: "Request" },
    { urlPattern: "https://www-hj.douyin.com/aweme/v1/web/history/*", requestStage: "Request" },
  ] });
  for (const host of ["www", "www-hj"]) {
    paused({ requestId: host, request: { url: `https://${host}.douyin.com/aweme/v1/web/history/write/?x=1` } });
    expect(network.send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: host, errorReason: "BlockedByClient" });
  }
  paused({ requestId: "read", request: { url: "https://www.douyin.com/aweme/v1/web/history/read/?cursor=0" } });
  expect(network.send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "read" });
  expect(network.send.mock.calls.some(([method]) => method === "Network.setCacheDisabled")).toBe(false);
  const media = new Media();
  await media.play();
  media.autoplay = true;
  playListener({ target: media });
  mutation();
  expect(started).not.toHaveBeenCalled();
  expect(media.autoplay).toBe(false);
  expect(media.muted).toBe(true);
  expect(media.pause).toHaveBeenCalledTimes(2);
  expect(inserted.pause).toHaveBeenCalledOnce();
});

it("recognizes verification in a blank-body intermediate page or child frame", async () => {
  const page = { title: async () => "验证码中间页", locator: () => ({ innerText: async () => "    " }), frames: () => [] };
  expect(await pageNeedsVerification(page)).toBe(true);
  page.title = async () => "抖音";
  expect(await pageNeedsVerification(page)).toBe(false);
  page.frames = () => [{ url: () => "https://rmc.bytedance.com/verifycenter/captcha/v2?from=iframe" }];
  expect(await pageNeedsVerification(page)).toBe(true);
});
