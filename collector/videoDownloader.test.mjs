import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectDouyinMediaCandidates,
  discoverDouyinVideo,
  downloadMediaFile,
  fetchMediaStream,
  isAllowedMediaUrl,
  makeVideoFileName,
  normalizeDouyinVideoUrl,
  selectDouyinMediaCandidate,
  VideoDownloadError,
} from "./videoDownloader.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("normalizeDouyinVideoUrl", () => {
  it("accepts canonical and short HTTPS Douyin video links", () => {
    expect(normalizeDouyinVideoUrl("https://www.douyin.com/video/1234567890#comment")).toBe(
      "https://www.douyin.com/video/1234567890",
    );
    expect(normalizeDouyinVideoUrl("https://v.douyin.com/abc123/?enter_from=share")).toBe(
      "https://v.douyin.com/abc123/?enter_from=share",
    );
  });

  it("rejects non-Douyin and non-video URLs", () => {
    expect(() => normalizeDouyinVideoUrl("https://example.com/video/1")).toThrowError(VideoDownloadError);
    expect(() => normalizeDouyinVideoUrl("https://www.douyin.com/user/abc")).toThrowError(VideoDownloadError);
    expect(() => normalizeDouyinVideoUrl("http://www.douyin.com/video/1")).toThrowError(VideoDownloadError);
    expect(() => normalizeDouyinVideoUrl("https://user:pass@www.douyin.com/video/1")).toThrowError(VideoDownloadError);
    expect(() => normalizeDouyinVideoUrl("https://www.douyin.com:8443/video/1")).toThrowError(VideoDownloadError);
  });
});

describe("media candidate selection", () => {
  it("closes only the playback page and stops discovery when switching during navigation", async () => {
    const controller = new AbortController();
    let failNavigation;
    const page = {
      addInitScript: vi.fn(async () => {}),
      context: () => ({ newCDPSession: async () => ({ on() {}, send: async () => {} }) }),
      on: vi.fn(), off: vi.fn(),
      goto: vi.fn(() => new Promise((_resolve, reject) => { failNavigation = reject; })),
      close: vi.fn(async () => failNavigation?.(new Error("page closed"))),
    };
    const pending = discoverDouyinVideo({ newPage: async () => page }, "https://www.douyin.com/video/1234567890", { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalled());
    expect(page.addInitScript.mock.invocationCallOrder[0]).toBeLessThan(page.goto.mock.invocationCallOrder[0]);
    controller.abort();
    await rejected;
    expect(page.close).toHaveBeenCalled();
    expect(page.off).toHaveBeenCalledWith("response", expect.any(Function));
  });
  it("extracts playable streams while ignoring cover URLs", () => {
    const candidates = collectDouyinMediaCandidates({
      aweme_detail: {
        aweme_id: "123",
        video: {
          width: 720,
          height: 1280,
          cover: { url_list: ["https://p3.douyinvod.com/cover.jpg"] },
          play_addr: { url_list: ["https://p3.douyinvod.com/aweme/v1/play/video.mp4"] },
          bit_rate: [{ bit_rate: 2_000_000, play_addr: { url_list: ["https://p3.douyinvod.com/media-video-hd.mp4"] } }],
        },
      },
    });
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "https://p3.douyinvod.com/aweme/v1/play/video.mp4",
      "https://p3.douyinvod.com/media-video-hd.mp4",
    ]);
    expect(selectDouyinMediaCandidate(candidates)).toMatchObject({
      url: "https://p3.douyinvod.com/aweme/v1/play/video.mp4",
      type: "video+audio",
    });
  });

  it("resolves a playable stream from a Douyin detail response", async () => {
    let responseHandler;
    const payload = {
      aweme_detail: {
        aweme_id: "1234567890",
        desc: "测试详情",
        author: { nickname: "测试作者" },
        create_time: 1_735_689_600,
        video: {
          duration: 12_000,
          play_addr: { url_list: ["https://p3.douyinvod.com/aweme/v1/play/detail.mp4"] },
        },
      },
    };
    const page = {
      addInitScript: async () => {},
      context: () => ({ newCDPSession: async () => ({ on() {}, send: async () => {} }) }),
      on: (_event, handler) => { responseHandler = handler; },
      off: () => undefined,
      goto: async () => {
        await responseHandler({
          url: () => "https://www.douyin.com/aweme/v1/web/aweme/detail/",
          headers: () => ({ "content-type": "application/json" }),
          ok: () => true,
          json: async () => payload,
        });
      },
      url: () => "https://www.douyin.com/video/1234567890",
      title: async () => "测试详情 - 抖音",
      evaluate: async () => [],
      locator: () => null,
      close: async () => undefined,
    };
    const result = await discoverDouyinVideo({ newPage: async () => page }, "https://www.douyin.com/video/1234567890", {
      mediaWaitMs: 1_700,
    });
    expect(result).toMatchObject({
      videoId: "1234567890",
      title: "测试详情",
      author: "测试作者",
      durationSeconds: 12,
      media: { url: "https://p3.douyinvod.com/aweme/v1/play/detail.mp4" },
    });
  });

  it("keeps media hosts narrow", () => {
    expect(isAllowedMediaUrl("https://p3.douyinvod.com/aweme/v1/play/1")).toBe(true);
    expect(isAllowedMediaUrl("https://evil.example/aweme/v1/play/1")).toBe(false);
    expect(isAllowedMediaUrl("https://p3.douyinvod.com:8443/aweme/v1/play/1")).toBe(false);
  });
});

describe("fetchMediaStream", () => {
  const stream = { url: "https://v3-web.douyinvod.com/a.mp4", referer: "https://www.douyin.com/video/1", cookie: "a=1" };

  it("forwards the range with the page's referer and cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("part", { status: 206, headers: { "Content-Range": "bytes 0-3/10" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchMediaStream({ ...stream, range: "bytes=0-3" });
    expect(response.status).toBe(206);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Range: "bytes=0-3", Referer: stream.referer, Cookie: "a=1" });
  });

  it("refuses hosts outside the media allowlist before and after redirects", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMediaStream({ ...stream, url: "https://example.com/a.mp4" })).rejects.toMatchObject({ code: "invalid_media_url" });
    expect(fetchMock).not.toHaveBeenCalled();
    const redirected = new Response("x");
    Object.defineProperty(redirected, "url", { value: "https://example.com/a.mp4" });
    fetchMock.mockResolvedValue(redirected);
    await expect(fetchMediaStream(stream)).rejects.toMatchObject({ code: "media_http_error" });
    fetchMock.mockResolvedValue(new Response("expired", { status: 403 }));
    await expect(fetchMediaStream(stream)).rejects.toMatchObject({ code: "media_http_error" });
  });
});

describe("downloadMediaFile", () => {
  it("streams a video to a private file and atomically renames it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-video-download-"));
    temporaryDirectories.push(directory);
    const mp4 = Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"), Buffer.from("video-bytes")]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(mp4, {
      status: 200,
      headers: { "Content-Type": "video/mp4", "Content-Length": String(mp4.length) },
    })));
    const progress = vi.fn();
    const result = await downloadMediaFile({
      context: { cookies: vi.fn().mockResolvedValue([]) },
      media: { url: "https://p3.douyinvod.com/aweme/v1/play/1" },
      outputDirectory: directory,
      fileName: "示例视频-123.mp4",
      onProgress: progress,
    });
    await expect(readFile(result.filePath)).resolves.toEqual(mp4);
    expect(result.fileName).toBe("示例视频-123.mp4");
    expect(progress).toHaveBeenCalled();
  });

  it("reuses a valid existing file without another network request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-video-download-"));
    temporaryDirectories.push(directory);
    const mp4 = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00existing");
    const firstFetch = vi.fn().mockResolvedValue(new Response(mp4, { status: 200 }));
    vi.stubGlobal("fetch", firstFetch);
    const args = {
      context: { cookies: vi.fn().mockResolvedValue([]) },
      media: { url: "https://p3.douyinvod.com/aweme/v1/play/2" },
      outputDirectory: directory,
      fileName: "same.mp4",
    };
    await downloadMediaFile(args);
    const second = await downloadMediaFile(args);
    expect(second.skipped).toBe(true);
    expect(firstFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts the binary WebM signature without stripping its high bits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-video-download-"));
    temporaryDirectories.push(directory);
    // EBML header declaring the WebM document type.
    const webm = Buffer.from("1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810242858102", "hex");
    const fetchMock = vi.fn().mockResolvedValue(new Response(webm, {
      status: 200,
      headers: { "Content-Type": "video/webm" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const args = {
      context: { cookies: vi.fn().mockResolvedValue([]) },
      media: { url: "https://p3.douyinvod.com/video.webm" },
      outputDirectory: directory,
      fileName: "示例视频-456.mp4",
    };
    const first = await downloadMediaFile(args);
    await expect(readFile(first.filePath)).resolves.toEqual(webm);
    expect((await downloadMediaFile(args)).skipped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("makeVideoFileName", () => {
  it("removes path separators and keeps a deterministic fallback", () => {
    expect(makeVideoFileName({ title: " a/b:c ", videoId: "123" })).toBe("a_b_c-123.mp4");
    expect(makeVideoFileName({ title: "", sourceUrl: "https://v.douyin.com/x" })).toMatch(/^抖音视频-[a-f0-9]{10}\.mp4$/u);
  });

  it("keeps Unicode characters intact when the title reaches the filename limit", () => {
    const atLimit = makeVideoFileName({ title: `${"a".repeat(88)}😀`, videoId: "123" });
    const beyondLimit = makeVideoFileName({ title: `${"a".repeat(89)}😀`, videoId: "123" });
    expect(atLimit).toBe(`${"a".repeat(88)}😀-123.mp4`);
    expect(beyondLimit).toBe(`${"a".repeat(89)}-123.mp4`);
    expect(() => encodeURIComponent(beyondLimit)).not.toThrow();
  });

  it("keeps non-BMP letters intact when limiting a video identifier", () => {
    const fileName = makeVideoFileName({ title: "示例", videoId: `${"a".repeat(39)}𠀀` });
    expect(fileName).toBe(`示例-${"a".repeat(39)}.mp4`);
    expect(() => encodeURIComponent(fileName)).not.toThrow();
  });

  it("repairs malformed Unicode before a filename is used in a response header", () => {
    const fileName = makeVideoFileName({ title: "示例\uD83D", videoId: "123" });
    expect(fileName).toBe("示例\uFFFD-123.mp4");
    expect(() => encodeURIComponent(fileName)).not.toThrow();
  });
});
