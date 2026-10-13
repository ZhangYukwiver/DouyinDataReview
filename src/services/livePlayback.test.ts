import { beforeEach, describe, expect, it, vi } from "vitest";
import { playLiveStream } from "./livePlayback";

type Engine = {
  handler: ((event: string, data: { type: string; fatal: boolean }) => void) | null;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
const control = vi.hoisted(() => ({ supported: true, engines: [] as Engine[] }));
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError", NETWORK_ERROR: "networkError" };
    static isSupported() { return control.supported; }
    handler: Engine["handler"] = null;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    recoverMediaError = vi.fn();
    destroy = vi.fn();
    constructor() { control.engines.push(this); }
    on(_event: string, handler: Engine["handler"]) { this.handler = handler; }
  },
}));

function fixture(nativeSupport = "") {
  const target = Object.assign(new EventTarget(), {
    paused: true, muted: false, src: "", canPlayType: vi.fn(() => nativeSupport),
    play: vi.fn(async () => { target.paused = false; }),
    pause: vi.fn(() => { target.paused = true; }),
    removeAttribute: vi.fn(() => { target.src = ""; }), load: vi.fn(),
  });
  return { target, video: target as unknown as HTMLVideoElement, callbacks: { onError: vi.fn(), onAutoplayMuted: vi.fn() } };
}
const mediaError = (engine: Engine, fatal = true) => engine.handler?.("error", { type: "mediaError", fatal });

beforeEach(() => { control.supported = true; control.engines.length = 0; });

describe("live HLS playback", () => {
  it("uses MediaSource even when the browser advertises native HLS and starts after buffering", () => {
    const { target, video, callbacks } = fixture("maybe");
    const stop = playLiveStream(video, "https://pull-h5.douyincdn.com/live.m3u8", callbacks);
    expect(control.engines).toHaveLength(1);
    expect(control.engines[0]!.loadSource).toHaveBeenCalledWith("https://pull-h5.douyincdn.com/live.m3u8");
    expect(control.engines[0]!.attachMedia).toHaveBeenCalledWith(video);
    expect(target.play).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("canplay"));
    expect(target.play).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    stop();
  });

  it("recovers one fatal media error, then releases the stream and reports persistent failure", () => {
    const { video, callbacks } = fixture();
    const stop = playLiveStream(video, "https://pull-h5.douyincdn.com/live.m3u8", callbacks);
    const engine = control.engines[0]!;
    mediaError(engine, false);
    expect(engine.recoverMediaError).not.toHaveBeenCalled();
    mediaError(engine);
    expect(engine.recoverMediaError).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    mediaError(engine);
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(engine.destroy).toHaveBeenCalledOnce();
    stop();
    mediaError(engine);
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(engine.destroy).toHaveBeenCalledOnce();
  });

  it("lets HLS retry transient network failures and reports only exhausted failures", () => {
    const { video, callbacks } = fixture();
    playLiveStream(video, "https://pull-h5.douyincdn.com/live.m3u8", callbacks);
    const engine = control.engines[0]!;
    engine.handler?.("error", { type: "networkError", fatal: false });
    expect(callbacks.onError).not.toHaveBeenCalled();
    engine.handler?.("error", { type: "networkError", fatal: true });
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(engine.destroy).toHaveBeenCalledOnce();
  });

  it("mutes only when autoplay is blocked and ignores a pending rejection after closing", async () => {
    const { target, video, callbacks } = fixture();
    target.play.mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    const stop = playLiveStream(video, "https://pull-h5.douyincdn.com/live.m3u8", callbacks);
    target.dispatchEvent(new Event("canplay"));
    await vi.waitFor(() => expect(callbacks.onAutoplayMuted).toHaveBeenCalledOnce());
    expect(target.muted).toBe(true);
    expect(target.play).toHaveBeenCalledTimes(2);
    stop();

    const decoding = fixture();
    decoding.target.play.mockRejectedValueOnce(Object.assign(new Error("decode failed"), { name: "NotSupportedError" }));
    const stopDecoding = playLiveStream(decoding.video, "https://pull-h5.douyincdn.com/live.m3u8", decoding.callbacks);
    decoding.target.dispatchEvent(new Event("canplay"));
    await Promise.resolve();
    expect(decoding.callbacks.onAutoplayMuted).not.toHaveBeenCalled();
    stopDecoding();

    const pending = fixture();
    let reject!: (error: Error) => void;
    pending.target.play.mockImplementation(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const close = playLiveStream(pending.video, "https://pull-h5.douyincdn.com/live.m3u8", pending.callbacks);
    pending.target.dispatchEvent(new Event("canplay"));
    close();
    reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    await Promise.resolve();
    expect(pending.callbacks.onAutoplayMuted).not.toHaveBeenCalled();
    expect(pending.target.play).toHaveBeenCalledOnce();
  });

  it("stops the old stream and ignores late events when switching or closing", () => {
    const { target, video, callbacks } = fixture();
    const stop = playLiveStream(video, "https://pull-h5.douyincdn.com/live.m3u8", callbacks);
    const engine = control.engines[0]!;
    stop(); stop();
    target.dispatchEvent(new Event("canplay"));
    mediaError(engine);
    expect(target.play).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(engine.destroy).toHaveBeenCalledOnce();
    expect(target.pause).toHaveBeenCalledOnce();
    expect(target.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("supports native HLS without MediaSource and cleans up its error handler", () => {
    control.supported = false;
    const { target, video, callbacks } = fixture("probably");
    const stop = playLiveStream(video, "https://pull-h5.douyincdn.com/live.m3u8", callbacks);
    expect(target.src).toBe("https://pull-h5.douyincdn.com/live.m3u8");
    target.dispatchEvent(new Event("error"));
    expect(callbacks.onError).toHaveBeenCalledOnce();
    stop();
    target.dispatchEvent(new Event("error"));
    expect(callbacks.onError).toHaveBeenCalledOnce();
    const unsupported = fixture();
    playLiveStream(unsupported.video, "https://pull-h5.douyincdn.com/live.m3u8", unsupported.callbacks);
    expect(unsupported.callbacks.onError).toHaveBeenCalledOnce();
  });
});
