import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { probeMedia } from "../../collector/aiEdit/media.mjs";
import { muxMp4 } from "./mp4Mux.ts";

const samples = (count, step) => Array.from({ length: count }, (_, index) => ({
  data: new Uint8Array([index, 1, 2, 3]), timestamp: index * step, duration: step, key: index % 10 === 0,
}));

describe("muxMp4", () => {
  it("packs H.264 and AAC samples into an mp4 the collector can read back", async () => {
    // 测试放 .mjs：src 的 tsconfig 不带 node 类型
    // avcC：baseline 4.0，SPS/PPS 内容不重要；AAC-LC 44.1k 双声道
    const avcC = new Uint8Array([1, 0x42, 0xe0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x28, 1, 0, 2, 0x68, 0xce]);
    const parts = muxMp4([
      { kind: "video", width: 720, height: 1280, description: avcC, samples: samples(50, 200_000) },
      { kind: "audio", sampleRate: 44_100, channels: 2, description: new Uint8Array([0x12, 0x10]), samples: samples(431, (1024 * 1e6) / 44_100) },
    ]);
    const file = path.join(await mkdtemp(path.join(tmpdir(), "mux-")), "out.mp4");
    await writeFile(file, Buffer.concat(parts));
    const probed = await probeMedia(file, { roots: [path.dirname(file)] });
    expect(probed).toMatchObject({ width: 720, height: 1280 });
    expect(probed.duration_us).toBeGreaterThanOrEqual(9_990_000);
    expect(probed.duration_us).toBeLessThanOrEqual(10_010_000);
  });
});
