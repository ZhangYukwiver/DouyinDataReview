import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import type { PersonalVideoRecord } from "../domain/personalRecords";
import { createVideoBatchZip, loadBatchVideoFile, MAX_BATCH_BYTES, runVideoBatch, uniqueDownloadVideos, type BatchItem } from "./batchVideoDownload";

const record = (id: string, extra: Partial<PersonalVideoRecord> = {}): PersonalVideoRecord => ({ id, title: `视频 ${id}`, author: null, occurredAt: null, mediaType: "video", url: `https://www.douyin.com/video/${id}`, ...extra });
const file = (text = "video bytes") => ({ blob: new Blob([text], { type: "video/mp4" }), fileName: "相同标题.mp4" });
const items = (): BatchItem[] => [record("111"), record("222"), record("333")].map((item) => ({ record: item, status: "pending" }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("batch selection", () => {
  it("deduplicates a work across record IDs and share URLs while excluding unsupported records", () => {
    const result = uniqueDownloadVideos([
      record("111"), record("duplicate", { url: "https://www.iesdouyin.com/share/video/111/?from=share" }),
      record("modal", { url: "https://www.douyin.com/?modal_id=111" }),
      record("222", { mediaType: "image" }), record("333", { mediaType: "live" }),
      record("444", { url: null }), record("555", { url: "https://example.com/video/555" }),
      record("666", { url: "https://www.douyin.com/user/666" }), record("777"),
      record("short", { videoId: "777", url: "https://v.douyin.com/abc/" }),
    ]);
    expect(result.map((item) => item.id)).toEqual(["111", "777"]);
  });
});

describe("batch queue", () => {
  it("runs sequentially, continues after failures, and retries only unfinished files", async () => {
    let active = 0;
    let maxActive = 0;
    const load = vi.fn(async (item: PersonalVideoRecord) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); active -= 1;
      if (item.id === "222") throw new Error("作品已删除");
      return file(item.id);
    });
    const update = vi.fn();
    const result = await runVideoBatch(items(), { load, onUpdate: update, shouldStop: () => false });
    expect(maxActive).toBe(1);
    expect(result.map((item) => item.status)).toEqual(["complete", "failed", "complete"]);
    expect(result[1]?.error).toBe("作品已删除");
    expect(load.mock.calls.map(([item]) => item.id)).toEqual(["111", "222", "333"]);
    const retry = vi.fn(async () => file("retry"));
    const retried = await runVideoBatch(result, { load: retry, onUpdate: update, shouldStop: () => false });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retried.every((item) => item.status === "complete")).toBe(true);
    expect(retried[0]?.file).toBe(result[0]?.file);
  });

  it("finishes the active file on stop and resumes pending items without redownloading successes", async () => {
    let stop = false;
    const load = vi.fn(async () => { stop = true; return file(); });
    const result = await runVideoBatch(items(), { load, onUpdate: () => {}, shouldStop: () => stop });
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.map((item) => item.status)).toEqual(["complete", "pending", "pending"]);
    const resume = vi.fn(async () => file());
    const resumed = await runVideoBatch(result, { load: resume, onUpdate: () => {}, shouldStop: () => false });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resumed.every((item) => item.status === "complete")).toBe(true);
  });

  it("enforces the archive byte limit without discarding successful files", async () => {
    const first = { blob: { size: MAX_BATCH_BYTES } as Blob, fileName: "full.mp4" };
    const load = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(file());
    const result = await runVideoBatch(items(), { load, onUpdate: () => {}, shouldStop: () => false });
    expect(result[0]?.file).toBe(first);
    expect(result[1]?.status).toBe("failed");
    expect(result[1]?.error).toContain("500 MB");
    expect(load.mock.calls[1]?.[1]).toBe(0);
  });
});

describe("collector batch integration", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const job = (status: string, extra = {}) => new Response(JSON.stringify({ job: { id, status, sourceUrl: record("111").url, createdAt: "2026-09-16T00:00:00Z", ...extra } }));
  const connection = { baseUrl: "http://127.0.0.1:4765", token: "test-token" };

  it("polls the existing download API, checks capacity, and authenticates file retrieval", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(job("queued"))
      .mockResolvedValueOnce(job("running"))
      .mockResolvedValueOnce(job("complete", { bytes: 5, fileName: "video.mp4" }))
      .mockResolvedValueOnce(new Response("video", { headers: { "Content-Type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = loadBatchVideoFile(connection, record("111"), 100, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1600);
    const result = await pending;
    expect(await result.blob.text()).toBe("video");
    expect(result.fileName).toBe("video.mp4");
    expect(fetch.mock.calls[0]?.[1].body).toBe(JSON.stringify({ url: record("111").url }));
    expect(fetch.mock.calls.every(([, init]) => init.headers.Authorization === "Bearer test-token")).toBe(true);
    expect(fetch.mock.lastCall?.[0]).toBe(`${connection.baseUrl}/v1/downloads/${id}/file`);
  });

  it("does not fetch an oversized file or a failed job", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(job("complete", { bytes: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(loadBatchVideoFile(connection, record("111"), 100, new AbortController().signal)).rejects.toMatchObject({ code: "batch_size_limit" });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(job("failed", { errorCode: "content_unavailable", error: "作品不可访问" }));
    await expect(loadBatchVideoFile(connection, record("111"), 100, new AbortController().signal)).rejects.toThrow("作品不可访问");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops polling when the workspace is unmounted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(job("queued"));
    vi.stubGlobal("fetch", fetch);
    const pending = loadBatchVideoFile(connection, record("111"), 100, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ZIP export", () => {
  it("produces an extractable ZIP with exact bytes, distinct safe names, and only successful videos", async () => {
    const source = items();
    source[0] = { ...source[0]!, status: "complete", file: { ...file("first"), fileName: "../相同标题.mp4" } };
    source[1] = { ...source[1]!, status: "complete", file: { ...file("second"), fileName: "../相同标题.mp4" } };
    source[2] = { ...source[2]!, status: "failed", error: "unavailable" };
    const archive = await createVideoBatchZip(source);
    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["001_.._相同标题.mp4", "002_.._相同标题.mp4"]);
    expect(Object.values(entries).map((bytes) => new TextDecoder().decode(bytes))).toEqual(["first", "second"]);
    expect(archive.type).toBe("application/zip");
  });
});
