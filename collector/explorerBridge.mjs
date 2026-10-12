import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExploreError } from "./explorer.mjs";
import { DirectExplorer } from "./directExplorer.mjs";
import { downloadDouyinVideo } from "./videoDownloader.mjs";

// Additive adapter. The original collector and its download jobs retain their
// behavior and data format. Explore owns its tabs and temporary playback files.
export class ExplorerBridge {
  constructor(collector) {
    this.collector = collector;
    this.pending = null;
    this.explorer = new DirectExplorer(null,
      options => collector.ensureDirectApi(options),
      options => collector.getDirectChatClient(options));
  }
  get busy() { return this.pending !== null; }
  collectorBusy() {
    return Boolean(this.collector.syncPromise || this.collector.hasActiveVideoDownload());
  }
  async run(input, operation = "read", signal) {
    if (this.busy || this.collectorBusy()) throw new ExploreError("collector_busy", "采集器正在执行任务，请停止采集或等待完成后再探索。");
    const work = Promise.resolve().then(() => operation === "interact" ? this.explorer.interact(input) : operation === "video" ? this.video(input, signal) : this.explorer.read(input, { signal }));
    this.pending = work;
    try { return await work; } finally { if (this.pending === work) this.pending = null; }
  }
  async video(input, signal) {
    const session = this.explorer.sessions.get(input?.sessionId);
    if (!session || session.kind !== "detail" || !session.video?.url || !session.direct)
      throw new ExploreError("session_expired", "请重新打开作品详情后播放。", 410);
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-explore-media-"));
    const dispose = () => rm(directory, { recursive: true, force: true });
    try {
      const context = await this.collector.ensureDirectApi({ signal });
      const file = await downloadDouyinVideo({ context, sourceUrl: session.video.url, outputDirectory: directory, signal });
      return { ...file, dispose };
    } catch (error) { await dispose(); throw error; }
  }
  async close(sessionIds) {
    if (this.pending) await this.pending.catch(() => {});
    const selected = Array.isArray(sessionIds) ? sessionIds.slice(0, 100) : [...this.explorer.sessions.keys()];
    const work = (async () => {
      for (const id of selected) this.explorer.sessions.delete(id);
    })();
    this.pending = work;
    try { await work; } finally { if (this.pending === work) this.pending = null; }
  }
}
