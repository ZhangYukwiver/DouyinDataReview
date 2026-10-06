import { describe, expect, it, vi } from "vitest";

import type { DesktopUpdateState } from "../../desktopRuntime";
import type { CollectorStatus } from "../../services/localCollector";
import {
  accountBlockedReason,
  activeAccountLabel,
  appUpdateAction,
  deriveSetup,
  formatLongDay,
  formatWhen,
  hourName,
  recordSummary,
  hasAppUpdate,
  readActions,
  runReadCommand,
  tipNotes,
  type ReadActionInput,
  type ReadCommand,
  type SetupInput,
} from "./setupModel";

function status(over: Partial<CollectorStatus> = {}): CollectorStatus {
  return {
    state: "idle",
    phase: null,
    message: "",
    counts: { watch_history: 0, liked_videos: 0, favorite_videos: 0, chat_messages: 0 },
    progress: null,
    updatedAt: null,
    browserOpen: false,
    code: null,
    chatConnection: null,
    syncMode: null,
    chat: { state: "idle", connection: null, message: null, progress: null, code: null },
    account: null,
    ...over,
  };
}

const base: SetupInput = { connected: true, busy: false, observing: false, chatCollecting: false, status: status(), snapshotSource: "collector", total: 120 };
const buttons: Omit<ReadActionInput, "connected" | "busy" | "observing" | "chatCollecting"> = { chatBusy: false, stoppingSync: false, switchingAccount: false, stoppingChat: false };

/** 按某个状态推一遍五个按钮，按 key 取出来 */
function actionsFor(input: Partial<SetupInput> = {}, extra: Partial<ReadActionInput> = {}) {
  const setup = { ...base, ...input };
  const state = deriveSetup(setup);
  const list = readActions({ ...buttons, connected: setup.connected, busy: setup.busy, observing: setup.observing, chatCollecting: setup.chatCollecting, ...extra }, state);
  return Object.fromEntries(list.map((action) => [action.key, action]));
}

describe("采集器页状态", () => {
  it("没连上、没数据：尚未连接，流向停在采集器这一步", () => {
    const state = deriveSetup({ ...base, connected: false, status: null, snapshotSource: null, total: 0 });
    expect(state.ready).toBe(false);
    expect(state.syncing).toBe(false);
    expect(state.source).toBe("尚未连接");
    expect(state.statusLine).toBe("尚未连接");
    expect(state.flow).toEqual({ step: 1, done: [false, false, false], note: "先连上" });
  });

  it("采集器说读完了，哪怕一条没有也算可以看", () => {
    expect(deriveSetup({ ...base, total: 0, status: status({ state: "complete" }) }).ready).toBe(true);
    expect(deriveSetup({ ...base, total: 0 }).flow.note).toBe("去读取");
  });

  it("忙着采集而报告还用旧数据时，顶栏要说一声；用导入的文件时不说", () => {
    expect(deriveSetup({ ...base, busy: true }).statusLine).toBe("本地采集器 · 采集中，报告用采集前的数据");
    expect(deriveSetup({ ...base, busy: true, snapshotSource: "archive" }).statusLine).toBe("备用文件导入");
    expect(deriveSetup({ ...base, busy: true, total: 0 }).statusLine).toBe("本地采集器");
  });

  it("增量读取和完整读取靠 syncMode 分开", () => {
    const direct = deriveSetup({ ...base, status: status({ state: "collecting", syncMode: "direct_records" }) });
    expect([direct.syncing, direct.directSyncing, direct.pageSyncing, direct.visibleBusy]).toEqual([true, true, false, false]);
    const page = deriveSetup({ ...base, status: status({ state: "collecting", syncMode: "page" }) });
    expect([page.syncing, page.directSyncing, page.pageSyncing, page.visibleBusy]).toEqual([true, false, true, true]);
    expect(page.flow.note).toBe("读取中");
  });

  it("手动监听不算读取，但占着可见浏览器", () => {
    const state = deriveSetup({ ...base, observing: true, status: status({ state: "observing" }) });
    expect(state.syncing).toBe(false);
    expect(state.visibleBusy).toBe(true);
  });

  it("要登录时流向回到第一步", () => {
    expect(deriveSetup({ ...base, status: status({ state: "awaiting_login" }) }).flow.step).toBe(0);
    const coded = deriveSetup({ ...base, status: status({ state: "error", code: "login_required" }) });
    expect(coded.loginNeeded).toBe(true);
    expect(coded.flow).toEqual({ step: 0, done: [false, true, true], note: "要登录" });
  });

  it("聊天：有整理进度或还没进入接收就算在读历史，单纯接收不算", () => {
    const progress = { current: 3, total: 10 };
    expect(deriveSetup({ ...base, chatCollecting: true, status: status({ chat: { state: "observing", connection: "connected", message: null, progress, code: null } }) }).chatReading).toBe(true);
    expect(deriveSetup({ ...base, chatCollecting: true, status: status({ chat: { state: "launching_browser", connection: null, message: null, progress: null, code: null } }) }).chatReading).toBe(true);
    expect(deriveSetup({ ...base, chatCollecting: true, status: status({ chat: { state: "observing", connection: "connected", message: null, progress: null, code: null } }) }).chatReading).toBe(false);
    expect(deriveSetup({ ...base, chatCollecting: false, status: status({ chat: { state: "observing", connection: null, message: null, progress, code: null } }) }).chatReading).toBe(false);
  });
});

describe("五个读取按钮", () => {
  it("没连上：全部禁用，文案是开始态", () => {
    const actions = actionsFor({ connected: false, status: null, total: 0 });
    expect(Object.values(actions).every((action) => action.disabled)).toBe(true);
    expect(Object.values(actions).map((action) => action.label)).toEqual(["增量读取", "完整读取", "手动监听", "开始接收", "采集聊天记录"]);
  });

  it("连上了闲着：五个都能点，按下去各自开始", () => {
    const actions = actionsFor();
    expect(Object.values(actions).map((action) => action.disabled)).toEqual([false, false, false, false, false]);
    expect(Object.values(actions).map((action) => action.command)).toEqual(["start-incremental", "start-full", "start-observation", "start-chat", "collect-chat-history"]);
    expect(Object.values(actions).some((action) => action.busy)).toBe(false);
  });

  it("增量读取中：增量变停止键，完整读取和手动监听让开", () => {
    const actions = actionsFor({ busy: true, status: status({ state: "collecting", syncMode: "direct_records" }) });
    expect(actions.incremental).toMatchObject({ label: "停止读取", icon: "pause", disabled: false, command: "stop-sync", busy: false });
    expect(actions.full!.disabled).toBe(true);
    expect(actions.observe!.disabled).toBe(true);
    // 正在停：停止键转圈
    expect(actionsFor({ busy: true, status: status({ state: "collecting", syncMode: "direct_records" }) }, { stoppingSync: true }).incremental!.busy).toBe(true);
  });

  it("完整读取中：完整变停止键，增量和聊天都让开", () => {
    const actions = actionsFor({ busy: true, status: status({ state: "collecting", syncMode: "page" }) });
    expect(actions.full).toMatchObject({ label: "停止读取", icon: "pause", disabled: false, command: "stop-sync" });
    expect(actions.incremental).toMatchObject({ label: "增量读取", disabled: true, busy: false });
    expect(actions.chat!.disabled).toBe(true);
    expect(actions.history!.disabled).toBe(true);
  });

  it("采集器忙但还没进入读取（刚按下增量）：增量按钮转圈", () => {
    expect(actionsFor({ busy: true }).incremental).toMatchObject({ label: "增量读取", busy: true, disabled: true });
  });

  it("手动监听中：监听变停止键，读取和聊天都等它", () => {
    const actions = actionsFor({ observing: true, status: status({ state: "observing" }) });
    expect(actions.observe).toMatchObject({ label: "停止监听", icon: "pause", disabled: false, command: "stop-observation" });
    expect(actions.incremental!.disabled).toBe(true);
    expect(actions.full!.disabled).toBe(true);
    expect(actions.chat!.disabled).toBe(true);
    expect(actions.history!.disabled).toBe(true);
  });

  it("聊天接收中：开始接收变暂停接收，采集聊天记录照样能点", () => {
    const actions = actionsFor({ chatCollecting: true, status: status({ chat: { state: "observing", connection: "connected", message: null, progress: null, code: null } }) });
    expect(actions.chat).toMatchObject({ label: "暂停接收", icon: "pause", disabled: false, command: "stop-observation" });
    expect(actions.history).toMatchObject({ label: "采集聊天记录", disabled: false, command: "collect-chat-history" });
  });

  it("聊天历史整理中：采集聊天记录变停止键，正在停时禁用并转圈", () => {
    const reading = { chatCollecting: true, status: status({ chat: { state: "observing", connection: "connected", message: null, progress: { current: 4, total: 20 }, code: null } }) };
    expect(actionsFor(reading).history).toMatchObject({ label: "停止读取", icon: "pause", disabled: false, busy: false, command: "stop-chat-history" });
    expect(actionsFor(reading, { stoppingChat: true }).history).toMatchObject({ disabled: true, busy: true });
    // 聊天控制在忙（chatBusy）：接收键禁用，历史停止键不受影响
    const busyChat = actionsFor(reading, { chatBusy: true });
    expect(busyChat.chat!.disabled).toBe(true);
    expect(busyChat.history!.disabled).toBe(false);
  });

  it("正在换号：两个聊天按钮禁用", () => {
    const actions = actionsFor({}, { switchingAccount: true });
    expect(actions.chat!.disabled).toBe(true);
    expect(actions.history!.disabled).toBe(true);
    expect(actions.incremental!.disabled).toBe(false);
  });
});

describe("按钮按下去调哪个回调", () => {
  function handlers() {
    return {
      onStartIncrementalSync: vi.fn(),
      onStartFullSync: vi.fn(),
      onStopSync: vi.fn(async () => undefined),
      onStartObservation: vi.fn(async () => undefined),
      onStopObservation: vi.fn(async () => undefined),
      onStartChatObservation: vi.fn(async () => undefined),
      onCollectChatHistory: vi.fn(async () => undefined),
      setStoppingChat: vi.fn(),
    };
  }

  it.each<[ReadCommand, string]>([
    ["start-incremental", "onStartIncrementalSync"],
    ["start-full", "onStartFullSync"],
    ["stop-sync", "onStopSync"],
    ["start-observation", "onStartObservation"],
    ["stop-observation", "onStopObservation"],
    ["start-chat", "onStartChatObservation"],
    ["collect-chat-history", "onCollectChatHistory"],
  ])("%s → %s", (command, name) => {
    const h = handlers();
    runReadCommand(command, h);
    for (const [key, fn] of Object.entries(h)) expect(fn).toHaveBeenCalledTimes(key === name ? 1 : 0);
  });

  it("停止读取聊天：先置成正在停，停完再放开", async () => {
    const h = handlers();
    let finish: () => void = () => undefined;
    h.onStopObservation.mockImplementation(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    runReadCommand("stop-chat-history", h);
    expect(h.setStoppingChat.mock.calls).toEqual([[true]]);
    finish();
    await vi.waitFor(() => expect(h.setStoppingChat.mock.calls).toEqual([[true], [false]]));
  });
});

describe("提示文案", () => {
  const tip = { fromArchive: false, connected: true, loginNeeded: false, syncing: false, ready: true, autoSyncEnabled: true };

  it("第一条跟着状态走，后两条固定", () => {
    expect(tipNotes({ ...tip, connected: false, ready: false }).map((note) => note.key)).toEqual(["tip", "privacy", "carry"]);
    expect(tipNotes({ ...tip, connected: false, ready: false })[0]!.title).toBe("第一次用？");
    expect(tipNotes({ ...tip, loginNeeded: true })[0]!.title).toBe("要先登录抖音");
    expect(tipNotes({ ...tip, syncing: true })[0]!.title).toBe("正在读取");
    expect(tipNotes({ ...tip, ready: false })[0]!.title).toBe("连上了，下一步读取");
    expect(tipNotes({ ...tip, autoSyncEnabled: false })[0]!.body).toContain("自动读取已暂停");
    expect(tipNotes({ ...tip, fromArchive: true, connected: false })[0]!.body).toContain("重新导入");
  });

  it("极简版不说按钮在哪边，导出数据指到设置里", () => {
    const sketch = tipNotes({ ...tip, fromArchive: true });
    const minimal = tipNotes({ ...tip, fromArchive: true }, "minimal");
    expect(sketch[0]!.body).toContain("点右边的「移除」");
    expect(minimal[0]!.body).not.toContain("右边");
    expect(minimal[2]!.body).toContain("设置里「导出数据」");
  });
});

describe("账号与更新", () => {
  const accounts = { activeId: "0123456789ab", accounts: [{ id: "default", nickname: "主号", avatar: null, uid: null, createdAt: null }, { id: "0123456789ab", nickname: null, avatar: null, uid: null, createdAt: null }] };

  it("账号名：没连上写抖音账号，状态里的昵称优先", () => {
    expect(activeAccountLabel(false, status({ account: { id: "default", nickname: "主号", avatar: null } }), accounts)).toBe("抖音账号");
    expect(activeAccountLabel(true, status({ account: { id: "default", nickname: "主号", avatar: null } }), accounts)).toBe("主号");
    expect(activeAccountLabel(true, status(), null)).toBe("抖音账号");
    expect(activeAccountLabel(true, status(), accounts)).not.toBe("抖音账号");
  });

  it("换号被挡住的原因按先后排", () => {
    const none = { switchingAccount: false, observing: false, syncing: false, busy: false, downloading: false, sparkRenewing: false };
    expect(accountBlockedReason(none)).toBeNull();
    expect(accountBlockedReason({ ...none, busy: true, syncing: true })).toContain("正在读取记录");
    expect(accountBlockedReason({ ...none, sparkRenewing: true })).toContain("续火花");
  });

  it("更新按钮按阶段换", () => {
    const update = (over: Partial<DesktopUpdateState>): DesktopUpdateState => ({ phase: "idle", currentVersion: "1.5.1", version: null, releaseName: null, releaseDate: null, releaseNotes: null, progress: null, bytesPerSecond: null, transferred: null, total: null, message: "", error: null, checkedAt: null, manualDownload: false, ...over });
    expect(appUpdateAction(update({ phase: "available", manualDownload: true }), false)).toEqual({ label: "去下载", kind: "download", disabled: false });
    expect(appUpdateAction(update({ phase: "available" }), false)!.label).toBe("下载更新");
    expect(appUpdateAction(update({ phase: "downloaded" }), true)).toEqual({ label: "采集完成后安装", kind: "install", disabled: true });
    expect(appUpdateAction(update({ phase: "downloaded" }), false)!.label).toBe("重启并安装");
    expect(appUpdateAction(update({ phase: "unsupported" }), false)).toBeNull();
    expect(appUpdateAction(update({ phase: "checking" }), false)).toEqual({ label: "检查更新", kind: "check", disabled: true });
    expect(appUpdateAction(update({ phase: "error" }), false)!.label).toBe("重试检查");
    expect(hasAppUpdate(update({ phase: "available" }))).toBe(true);
    expect(hasAppUpdate(update({ phase: "downloaded" }))).toBe(true);
    expect(hasAppUpdate(update({ phase: "up-to-date" }))).toBe(false);
    expect(hasAppUpdate(null)).toBe(false);
  });
});

describe("日期说法", () => {
  const now = new Date(2026, 9, 6, 15, 0).getTime();

  it("最近记录的时间：今天写时分，昨天写昨天，今年写月日，往年带年份", () => {
    expect(formatWhen(new Date(2026, 9, 6, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatWhen(new Date(2026, 9, 5, 23, 0).getTime(), now)).toBe("昨天");
    expect(formatWhen(new Date(2026, 2, 1).getTime(), now)).toBe("3/1");
    expect(formatWhen(new Date(2025, 11, 31).getTime(), now)).toBe("2025/12/31");
  });

  it("长日期今年省年份；卡头总结带上最早一天", () => {
    expect(formatLongDay(new Date(2026, 0, 3).getTime(), false, now)).toBe("1 月 3 日");
    expect(formatLongDay(new Date(2025, 7, 1).getTime(), false, now)).toBe("2025 年 8 月 1 日");
    expect(recordSummary(4090, new Date(2026, 0, 3).getTime())).toBe("一共 4,090 条，最早到 2026 年 1 月 3 日。");
    expect(recordSummary(0, null)).toBe("观看、喜欢、收藏与聊天");
    expect(hourName(0)).toBe("凌晨 0 点");
    expect(hourName(12)).toBe("中午 12 点");
    expect(hourName(19)).toBe("晚上 7 点");
  });
});
