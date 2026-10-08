import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DouyinExplorer, ExploreError } from "./explorer.mjs";
import { downloadDouyinVideo } from "./videoDownloader.mjs";
import { closeContextWithin } from "./douyinCollector.mjs";

// Additive adapter. The original collector and its download jobs retain their
// behavior and data format. Explore owns its tabs and temporary playback files.
export class ExplorerBridge {
  constructor(collector) {
    this.collector = collector;
    this.pending = null;
    // close() 自己占着 pending 时（含关借来的会话），不能算「探索还在用」，否则它自己要调的释放会被挡回去
    this.closing = false;
    this.ownedContext = null;
    this.explorer = new DouyinExplorer(async () => {
      // Reuse the logged-in collector, including ready manual and chat listeners.
      // A second non-persistent Comet instance can crash on this host.
      let context = collector.context;
      if (!context) {
        const before = collector.getStatus();
        context = await collector.ensureBrowser({ headless: true });
        this.ownedContext = context;
        context.on("close", () => { if (this.ownedContext === context) this.ownedContext = null; });
        if (collector.getStatus().state === "launching_browser") collector.updateStatus({ state: before.state, message: before.message });
      }
      if (!await collector.hasLoginSession(context, null)) throw new ExploreError("login_required", "请先在手动监听中登录抖音，再重试搜索。");
      return context;
    });
    // 下载（keepExplore）复用探索的会话，不会自己关；用户在下载中途离开探索页时，
    // 那次 close 因为下载还在跑没关会话，所以每个下载收尾后再补一次空关闭：还有探索页面或别的任务在用就不动
    collector.afterVideoDownload = () => { void this.close([]).catch(() => {}); };
    // 探索页面还开着、或正在读的时候，采集器别的任务（创作者页空闲收尾等）不能把这个会话关掉
    // 页面已经关掉的陈旧会话（浏览器崩了之类）不算占着
    collector.exploreHoldsContext = () => (this.pending !== null && !this.closing) || [...this.explorer.sessions.values()].some((session) => !session.page?.isClosed?.());
  }
  get busy() { return this.pending !== null; }
  collectorBusy() {
    const current = this.collector;
    const receiving = current.isChatReceiving?.() || current.isManualObserving?.();
    return Boolean(current.syncPromise || (current.observationPromise && !receiving) || current.hasActiveVideoDownload());
  }
  async run(input, operation = "read", signal) {
    if (this.busy || this.collectorBusy()) throw new ExploreError("collector_busy", "采集器正在执行任务，请停止采集或等待完成后再探索。");
    const work = Promise.resolve().then(() => operation === "interact" ? this.explorer.interact(input) : operation === "video" ? this.video(input, signal) : this.explorer.read(input, { signal }));
    this.pending = work;
    try { return await work; } finally { if (this.pending === work) this.pending = null; }
  }
  async video(input, signal) {
    const session = this.explorer.sessions.get(input?.sessionId);
    if (!session || session.kind !== "detail" || !session.video?.url || session.page.isClosed())
      throw new ExploreError("session_expired", "请重新打开作品详情后播放。", 410);
    const directory = await mkdtemp(path.join(tmpdir(), "douyin-explore-media-"));
    const dispose = () => rm(directory, { recursive: true, force: true });
    try {
      const file = await downloadDouyinVideo({ context: session.page.context(), sourceUrl: session.video.url, outputDirectory: directory, signal });
      return { ...file, dispose };
    } catch (error) { await dispose(); throw error; }
  }
  async close(sessionIds) {
    if (this.pending) await this.pending.catch(() => {});
    const selected = Array.isArray(sessionIds) ? sessionIds.slice(0, 100) : [...this.explorer.sessions.keys()];
    this.closing = true;
    const work = (async () => {
      for (const id of selected) {
        const session = this.explorer.sessions.get(id);
        if (session) { this.explorer.sessions.delete(id); await session.page.close().catch(() => {}); }
      }
      // 聊天接收和无界面读取也可能在用这个会话，它们还在就别关
      const shared = this.collector.observationPromise || this.collector.chatPromise || this.collector.headlessWorkRunning?.();
      if (!this.explorer.sessions.size && this.ownedContext && !shared && !this.collectorBusy()) {
        const context = this.ownedContext; this.ownedContext = null;
        // 下载收尾会在没人等着的时候触发这里，所以要和采集器其他关闭路径一样限时，卡住也不能让 pending 一直占着
        await closeContextWithin(context);
      }
      // 这个会话要是创作者页、直播、下载先开的，探索只是借用，上面不会关它；别的任务收尾时又因为探索还开着页面跳过了，
      // 所以探索页面关光以后补一次（采集器自己会看聊天、无头任务和探索页面还在不在）。
      // 放在 pending 里做：关的时候新的探索读取会得到 collector_busy，不会趁旧会话还没关完就去起新的
      try { await this.collector.releaseHeadlessContextIfIdle?.(); } catch { /* 关不掉下次再说 */ }
    })();
    this.pending = work;
    try { await work; } finally { this.closing = false; if (this.pending === work) this.pending = null; }
  }
}
