import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { mergeQwenTimestamps, transcribeAudio } from "./videoAnalysisAsr.mjs";

describe("video analysis ASR", () => {
  it("aligns punctuation and spaces while splitting at pauses", () => {
    expect(mergeQwenTimestamps([
      { text: "你", start_time: 0, end_time: 0.1 },
      { text: "好", start_time: 0.1, end_time: 0.2 },
      { text: "世", start_time: 1.5, end_time: 1.6 },
      { text: "界", start_time: 1.6, end_time: 1.7 },
    ], "你好，世界。"))
      .toEqual([
        { startMs: 0, endMs: 200, text: "你好，" },
        { startMs: 1500, endMs: 1700, text: "世界。" },
      ]);
    expect(mergeQwenTimestamps([
      { text: "hello", start_time: 0, end_time: 0.1 },
      { text: "world", start_time: 0.1, end_time: 0.2 },
    ], "hello world")[0].text).toBe("hello world");
  });

  it("rejects non-empty text without timestamps and accepts a timed silence result", () => {
    expect(() => mergeQwenTimestamps([], "有文字但没有时间")).toThrowError(expect.objectContaining({ code: "qwen_timing_missing" }));
    expect(mergeQwenTimestamps([], "")).toEqual([]);
  });

  it.each(["success", "quota"])("reads the full Qwen queue response for %s", async outcome => {
    const audioPath = path.join(tmpdir(), `video-analysis-asr-${Date.now()}.mp3`);
    await writeFile(audioPath, Buffer.from("sample"));
    try {
      const fetchImpl = vi.fn(async (url, init = {}) => {
        if (url.endsWith("/config")) return Response.json({ dependencies: [{ id: 4, api_name: "transcribe" }] });
        if (url.endsWith("/upload")) {
          expect(init.body.get("files").type).toBe("audio/mpeg");
          return new Response(JSON.stringify(["/tmp/sample.mp3"]));
        }
        if (url.endsWith("/queue/join")) {
          expect(JSON.parse(init.body)).toMatchObject({ fn_index: 4, session_hash: expect.any(String) });
          return Response.json({ event_id: "evt" });
        }
        expect(url).toContain("/queue/data?session_hash=");
        const output = outcome === "quota" ? { title: "ZeroGPU quota exceeded", error: "You have exceeded your ZeroGPU quota (60s requested vs. 0s left)." }
          : { data: ["Chinese", "你好", [{ text: "你好", start_time: 0.5, end_time: 1.2 }], ""] };
        return new Response('data: {"msg":"process_starts","event_id":"evt"}\n\ndata: ' + JSON.stringify({
          msg: "process_completed", success: outcome === "success", event_id: "evt", output,
        }) + "\r\n\r\n");
      });
      const result = transcribeAudio({ engine: "qwen", audioPath, fetchImpl });
      if (outcome === "quota") await expect(result).rejects.toMatchObject({ code: "qwen_quota", message: expect.stringContaining("剩余 0 秒") });
      else await expect(result).resolves.toEqual([{ startMs: 500, endMs: 1200, text: "你好" }]);
    } finally {
      await rm(audioPath, { force: true });
    }
  });
});
