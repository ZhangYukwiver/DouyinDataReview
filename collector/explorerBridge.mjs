import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExploreError } from "./explorer.mjs";
import { DirectExplorer } from "./directExplorer.mjs";
import { sentComment } from "./myComments.mjs";
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
    // 推荐翻页、点赞收藏、记观看历史都是互不相干的单个请求：不跟视频准备和别的探索排队，只在整份读取时让路
    if (operation === "react" || operation === "seen" || (operation === "read" && input?.kind === "feed")) {
      if (this.collector.syncPromise) throw new ExploreError("collector_busy", "采集器正在读取记录，请稍后再试。");
      if (operation === "read") return this.explorer.read(input, { signal });
      if (operation === "seen") {
        const result = await this.explorer.seen(input);
        this.collector.noteFeedWatch(input);
        this.collector.scheduleWatchHistoryRefresh();
        return result;
      }
      const result = await this.explorer.react(input);
      if (input.action === "comment") this.noteComment(input.awemeId, result);
      else if (result.outcome === "confirmed") void this.syncReaction(input).catch(() => {});
      return result;
    }
    if (this.busy || this.collectorBusy()) throw new ExploreError("collector_busy", "采集器正在执行任务，请停止采集或等待完成后再探索。");
    const commentOn = operation === "interact" && input?.action === "comment" ? this.explorer.sessions?.get(input.sessionId)?.id : null;
    const work = Promise.resolve().then(() => operation === "interact" ? this.explorer.interact(input) : operation === "seen" ? this.explorer.seen(input) : operation === "video" ? this.video(input, signal) : this.explorer.read(input, { signal }));
    this.pending = work;
    try {
      const result = await work;
      if (commentOn) this.noteComment(commentOn, result);
      return result;
    } finally { if (this.pending === work) this.pending = null; }
  }
  /** 评论发出去了（抖音回执确认过）：记进内容库「我的评论」，之后读到的回复挂在它下面 */
  noteComment(videoId, result) {
    const sent = result?.outcome === "confirmed" ? sentComment(videoId, result.comment) : null;
    if (sent) void this.collector.myComments?.addSent(sent).catch(() => {});
  }
  /** 点赞 / 收藏成功后在后台读一次作品详情，放进或移出本机「喜欢」「收藏」，内容库不用等下次读取 */
  async syncReaction({ action, awemeId, desired }) {
    await delay(1_000);
    const api = await this.collector.ensureDirectApi({});
    const detail = (await api.request("/aweme/v1/web/aweme/detail/", { query: { aweme_id: awemeId }, referer: `https://www.douyin.com/video/${awemeId}` })).aweme_detail;
    if (String(detail?.aweme_id ?? "") !== awemeId) return;
    await this.collector.syncInteraction(action === "like" ? "liked_videos" : "favorite_videos", detail, desired);
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
