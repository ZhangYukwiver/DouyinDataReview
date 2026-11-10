import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAudio, extractFrames, inspectVideo } from "../collector/videoAnalysisMedia.mjs";

// Run in a child process using the same resource location that Electron provides.
// The two-second synthetic H.264/AAC fixture changes from black to white at 1s.
Object.defineProperty(process, "resourcesPath", { value: path.resolve(process.argv[2]) });
const sample = fileURLToPath(new URL("../collector/fixtures/video-analysis/cut-and-tone.mp4", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "packaged-media-"));
try {
  assert.deepEqual(await inspectVideo(sample), { hasAudio: true, durationMs: 2000 });
  const audio = path.join(temporary, "audio.mp3");
  assert.deepEqual(await extractAudio(sample, audio), { silent: false });
  assert.ok((await stat(audio)).size > 1000);
  const frames = await extractFrames(sample, path.join(temporary, "frames"));
  assert.ok(frames.some(f => f.timeMs === 0) && frames.some(f => f.timeMs === 1000), "Missing start or cut timestamp");
} finally {
  await rm(temporary, { force: true, recursive: true });
}
