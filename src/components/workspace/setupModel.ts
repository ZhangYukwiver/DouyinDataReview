import type { DesktopUpdateState } from "../../desktopRuntime";
import { canReadCollector, collectorAccountName, type CollectorAccounts, type CollectorStatus } from "../../services/localCollector";

// 采集器页两套版式（手绘 / 极简）和设置面板共用的推导：同一个按钮在哪套里都按同一套条件禁用、
// 同一个状态在哪套里都写同一句话。这里只有纯函数，版式各自决定怎么画。

/** 正在通过接口读取记录 */
export function isCollectorSyncing(connected: boolean, status: CollectorStatus | null): boolean {
  return connected && ["launching_browser", "awaiting_login", "collecting"].includes(status?.state ?? "");
}

export interface AccountBlockInput {
  switchingAccount: boolean;

  syncing: boolean;
  busy: boolean;
  downloading: boolean;
  sparkRenewing: boolean;
}

// 切换前等接口读取结束；聊天接收和直播连接会由采集器停止。
export function accountBlockedReason({ switchingAccount, syncing, busy, downloading, sparkRenewing }: AccountBlockInput): string | null {
  return switchingAccount ? "正在切换账号，稍等一下。"
      : syncing ? "正在读取记录，先停下再切换账号。"
        : busy ? "采集器正在忙，等它忙完再切换账号。"
          : downloading ? "正在下载视频，等下完再切换账号。"
            : sparkRenewing ? "正在续火花，等发完或先停下再切换账号。"
              : null;
}

/** 顶栏和设置里显示的抖音账号名：采集器状态里的昵称优先，其次是账号列表里当前那一个，都没有就写「抖音账号」 */
/** 当前账号的名字：采集器状态里的昵称优先，其次是账号表里的名字；没连上或认不出时是 null */
export function activeAccountName(connected: boolean, status: CollectorStatus | null, accounts: CollectorAccounts | null): string | null {
  if (!connected) return null;
  const rows = accounts?.accounts ?? [];
  const activeId = accounts?.activeId ?? status?.account?.id ?? null;
  const index = rows.findIndex((account) => account.id === activeId);
  return status?.account?.nickname ?? (index >= 0 ? collectorAccountName(rows[index]!, index) : null);
}

export function activeAccountLabel(connected: boolean, status: CollectorStatus | null, accounts: CollectorAccounts | null): string {
  return activeAccountName(connected, status, accounts) ?? "抖音账号";
}

// ---------- 页面状态 ----------

export interface SetupInput {
  connected: boolean;
  busy: boolean;

  chatCollecting: boolean;
  status: CollectorStatus | null;
  snapshotSource: "collector" | "archive" | null;
  /** 观看 + 喜欢 + 收藏 + 聊天的条数 */
  total: number;
}

export interface SetupFlow {
  /** 数据流向走到哪一步：0 抖音网页 → 1 本机采集器 → 2 本地记录 → 3 报告 */
  step: number;
  /** 前三步各自做完没有 */
  done: [boolean, boolean, boolean];
  note: string;
}

export interface SetupState {
  videosAllowed: boolean;
  chatAllowed: boolean;
  /** 有数据可看：读到过记录、采集器说读完了，或者正用着导入的文件 */
  ready: boolean;
  syncing: boolean;
  /** 凭据导出期间暂时禁用读取操作 */
  visibleBusy: boolean;
  /** 完整与增量都走接口，通过 syncFull 区分发起按钮 */
  fullSyncing: boolean;
  directSyncing: boolean;
  chatProgress: CollectorStatus["progress"];
  /** 聊天历史还在整理（连接接口、逐个会话读）：「采集聊天记录」变成停止键，停下就是停掉这一轮接收，已读到的照样留着 */
  chatReading: boolean;
  loginNeeded: boolean;
  fromArchive: boolean;
  /** 数据从哪来：备用文件导入 / 本地采集器 / 尚未连接 */
  source: string;
  /** 顶栏状态那一行；采集器在忙而报告还用着采集前的数据时要说一声 */
  statusLine: string;
  flow: SetupFlow;
}

export function deriveSetup({ busy, chatCollecting, connected, snapshotSource, status, total }: SetupInput): SetupState {
  const ready = total > 0 || status?.state === "complete" || snapshotSource === "archive";
  const syncing = isCollectorSyncing(connected, status);
  const visibleBusy = status?.browserSource?.credentials === "exporting";
  const fullSyncing = syncing && (status?.syncFull === true || status?.syncMode === "page");
  const directSyncing = syncing && !fullSyncing;
  const chatProgress = status?.chat.progress ?? null;
  const chatReading = chatCollecting && (status?.chat.state !== "observing" || chatProgress !== null);
  const loginNeeded = status?.browserSource?.credentials === "reconnect_required" || status?.state === "awaiting_login"
    || ["login_required", "browser_reconnect_required"].includes(status?.code ?? "");
  const fromArchive = snapshotSource === "archive";
  const source = fromArchive ? "备用文件导入" : connected ? "本地采集器" : "尚未连接";
  const statusLine = busy && ready && snapshotSource === "collector" ? `${source} · 采集中，报告用采集前的数据` : source;
  const flow: SetupFlow = fromArchive
    ? { step: 3, done: [true, true, true], note: "可以看了" }
    : loginNeeded
      ? { step: 0, done: [false, connected, ready], note: "要导入凭据" }
      : !connected
        ? { step: 1, done: [false, false, ready], note: "先连上" }
        : syncing
          ? { step: 2, done: [true, true, false], note: "读取中" }
          : ready
            ? { step: 3, done: [true, true, true], note: "可以看了" }
            : { step: 2, done: [true, true, false], note: "去读取" };
  return { videosAllowed: canReadCollector(status, "videos"), chatAllowed: canReadCollector(status, "chat"),
    ready, syncing, visibleBusy, fullSyncing, directSyncing, chatProgress, chatReading, loginNeeded, fromArchive, source, statusLine, flow };
}

// ---------- 四个读取按钮 ----------

export type ReadActionKey = "incremental" | "full" | "chat" | "history";
export type ReadActionIcon = "play" | "pause" | "refresh" | "eye" | "message";
/** 按下去做什么；每种对应页面上的一个回调，见 runReadCommand */
export type ReadCommand =
  | "start-incremental"
  | "start-full"
  | "stop-sync"
  | "stop-chat"
  | "start-chat"
  | "collect-chat-history"
  | "stop-chat-history";

export interface ReadAction {
  key: ReadActionKey;
  label: string;
  icon: ReadActionIcon;
  disabled: boolean;
  /** 按钮上转圈 */
  busy: boolean;
  command: ReadCommand;
}

export interface ReadActionInput {
  connected: boolean;
  busy: boolean;

  chatCollecting: boolean;
  chatBusy: boolean;
  stoppingSync: boolean;
  switchingAccount: boolean;
  /** 页面自己记着的「停止读取聊天」正在停 */
  stoppingChat: boolean;
}

/** 增量读取 / 完整读取 / 开始接收 / 采集聊天记录：读取中哪个按钮发起的就由哪个变成停止键 */
export function readActions(input: ReadActionInput, state: Pick<SetupState, "visibleBusy" | "fullSyncing" | "directSyncing" | "chatReading" | "videosAllowed" | "chatAllowed">): ReadAction[] {
  const { busy, chatBusy, chatCollecting, connected, stoppingChat, stoppingSync, switchingAccount } = input;
  const { chatReading, directSyncing, fullSyncing, visibleBusy, videosAllowed, chatAllowed } = state;
  return [
    {
      key: "incremental",
      label: directSyncing ? "停止读取" : "增量读取",
      icon: directSyncing ? "pause" : "play",
      disabled: !connected || (!videosAllowed && !directSyncing) || (busy && !directSyncing) || visibleBusy,
      busy: directSyncing ? stoppingSync : busy && !fullSyncing,
      command: directSyncing ? "stop-sync" : "start-incremental",
    },
    {
      key: "full",
      label: fullSyncing ? "停止读取" : "完整读取",
      icon: fullSyncing ? "pause" : "refresh",
      disabled: !connected || (!fullSyncing && (!videosAllowed || busy || visibleBusy)),
      busy: fullSyncing && stoppingSync,
      command: fullSyncing ? "stop-sync" : "start-full",
    },
    {
      key: "chat",
      label: chatCollecting ? "暂停接收" : "开始接收",
      icon: chatCollecting ? "pause" : "message",
      disabled: !connected || chatBusy || switchingAccount || (!chatCollecting && (!chatAllowed || visibleBusy || busy)),
      busy: false,
      command: chatCollecting ? "stop-chat" : "start-chat",
    },
    {
      key: "history",
      label: chatReading ? "停止读取" : "采集聊天记录",
      icon: chatReading ? "pause" : "refresh",
      disabled: !connected || switchingAccount || (chatReading ? stoppingChat : !chatAllowed || chatBusy || visibleBusy || (busy && !chatCollecting)),
      busy: chatReading ? stoppingChat : chatBusy,
      command: chatReading ? "stop-chat-history" : "collect-chat-history",
    },
  ];
}

export interface ReadHandlers {
  onStartIncrementalSync: () => void;
  onStartFullSync: () => void;
  onStopSync: () => Promise<void>;
  onStopChatObservation: () => Promise<void>;
  onStartChatObservation: () => Promise<void>;
  onCollectChatHistory: () => Promise<void>;
  /** 停止读取聊天时先把按钮置成「正在停」，停完再放开 */
  setStoppingChat: (stopping: boolean) => void;
}

export function runReadCommand(command: ReadCommand, handlers: ReadHandlers): void {
  switch (command) {
    case "start-incremental": handlers.onStartIncrementalSync(); return;
    case "start-full": handlers.onStartFullSync(); return;
    case "stop-sync": void handlers.onStopSync(); return;
    case "stop-chat": void handlers.onStopChatObservation(); return;
    case "start-chat": void handlers.onStartChatObservation(); return;
    case "collect-chat-history": void handlers.onCollectChatHistory(); return;
    case "stop-chat-history":
      handlers.setStoppingChat(true);
      void handlers.onStopChatObservation().finally(() => handlers.setStoppingChat(false));
      return;
  }
}

// ---------- 状态提示 ----------

export interface SetupTip {
  key: "tip" | "privacy" | "carry";
  title: string;
  body: string;
}

export interface TipInput {
  fromArchive: boolean;
  connected: boolean;
  loginNeeded: boolean;
  syncing: boolean;
  ready: boolean;
  autoSyncEnabled: boolean;
  /** 桌面版：登录在首屏扫码，采集器自己连 */
  desktop?: boolean;
}

/** 桌面版首屏：连上了但凭据还没就绪（新装、新账号或失效）都算要登录，二维码就摆在那儿 */
export function desktopLoginNeeded(login: unknown, connected: boolean, status: CollectorStatus | null): boolean {
  const credentials = status?.browserSource?.credentials;
  return Boolean(login) && connected && status !== null && credentials !== "ready" && credentials !== "exporting";
}

/**
 * 按钮下面的几条提示：第一条跟着状态走，后两条是隐私和换电脑。
 * 两套版式按钮摆的地方不一样：手绘版「移除」在右边那张卡上、「导出数据」就在页面上；极简版「导出数据」收在设置里。
 */
export function tipNotes(state: TipInput, layout: "sketch" | "minimal" = "sketch"): SetupTip[] {
  const minimal = layout === "minimal";
  const tip = state.fromArchive
    ? { title: "用的是导入的文件", body: state.connected ? `报告和工作台都用这份文件。想换回采集器的数据，${minimal ? "把这份文件「移除」" : "点右边的「移除」"}就行。` : "报告和工作台都用这份文件，关掉应用后要重新导入。" }
    : state.loginNeeded
      ? state.desktop
        ? { title: "扫码以后", body: "在手机上确认登录，这里会显示是哪个抖音号；核对后导入凭据，读取会自动开始。" }
        : { title: "要先登录抖音", body: "在设置 → 账号中扫码登录（或连接已登录的浏览器），确认账号并导入凭据后再读取。" }
      : !state.connected
        ? state.desktop
          ? { title: "第一次用？", body: "应用自带的采集器连上后就能扫码登录抖音，确认账号后自动开始读取。" }
          : { title: "第一次用？", body: "点「连接采集器」，配对码会自动填好。然后在设置 → 账号中扫码登录（或连接已登录的浏览器）并导入凭据。" }
        : state.syncing
          ? { title: "正在读取", body: "随时可以点「停止读取」停下，已经读到的会先存好。" }
          : state.ready
            ? { title: "可以打开报告了", body: state.autoSyncEnabled ? "右上角「打开报告」看这些记录。应用回到前台时会自动补读新的记录。" : "右上角「打开报告」看这些记录。自动读取已暂停，想更新就点「增量读取」。" }
            : { title: "连上了，下一步读取", body: "「增量读取」在后台读最近的记录，不弹窗口；「完整读取」会从头翻一遍，要久一些。" };
  return [
    { key: "tip", ...tip },
    { key: "privacy", title: "只存在这台电脑上", body: "采集器只在本机运行，读到的记录都存在这台电脑里，不上传。" },
    { key: "carry", title: "换电脑怎么带走", body: minimal ? "先在设置里「导出数据」存成文件，到新电脑上「选择文件」导入，再「并入本机记录」。" : "先「导出数据」存成文件，到新电脑上「选择文件」导入，再「并入本机记录」。" },
  ];
}

// ---------- 应用更新 ----------

export interface AppUpdateAction {
  label: string;
  kind: "download" | "install" | "check";
  disabled: boolean;
}

/** 更新面板上那一个按钮：有新版就下载（或去发布页），下好了就重启安装（采集中先不装），其余时候检查更新 */
export function appUpdateAction(state: DesktopUpdateState, busy: boolean): AppUpdateAction | null {
  if (state.phase === "available") return { label: state.manualDownload ? "去下载" : "下载更新", kind: "download", disabled: false };
  if (state.phase === "downloaded") return { label: busy ? "采集完成后安装" : "重启并安装", kind: "install", disabled: busy };
  if (state.phase === "unsupported") return null;
  return { label: state.phase === "error" ? "重试检查" : "检查更新", kind: "check", disabled: state.phase === "checking" || state.phase === "downloading" };
}

/** 有可装的新版本（顶栏挂一个小提示） */
export function hasAppUpdate(state: DesktopUpdateState | null): boolean {
  return state?.phase === "available" || state?.phase === "downloaded";
}

// ---------- 日期和条数的说法 ----------

/** 内容记录卡头那一句：一共多少条、最早到哪天；没有记录时说能读到哪几类 */
export function recordSummary(total: number, first: number | null): string {
  const range = first !== null ? `，最早到 ${formatLongDay(first, true)}` : "";
  return total ? `一共 ${total.toLocaleString("zh-CN")} 条${range}。` : "观看、喜欢、收藏与聊天";
}

/** 「10/05 17:30」 */
export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : value;
}

/** 「9/22」 */
export function formatDay(time: number): string {
  const date = new Date(time);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** 「2025 年 8 月 1 日」；今年的日期省掉年份，除非明确要带 */
export function formatLongDay(time: number, withYear = false, now = Date.now()): string {
  const date = new Date(time);
  const year = withYear || date.getFullYear() !== new Date(now).getFullYear() ? `${date.getFullYear()} 年 ` : "";
  return `${year}${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

/** 今天的写几点几分，昨天写「昨天」，今年的写月/日，更早的带上年份 */
export function formatWhen(time: number, nowTime = Date.now()): string {
  const date = new Date(time);
  const now = new Date(nowTime);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= today) return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (time >= today - 86_400_000) return "昨天";
  return date.getFullYear() === now.getFullYear() ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** 「凌晨 3 点」「中午 12 点」「晚上 7 点」 */
export function hourName(hour: number): string {
  if (hour < 6) return `凌晨 ${hour} 点`;
  if (hour < 12) return `上午 ${hour} 点`;
  if (hour === 12) return "中午 12 点";
  if (hour < 18) return `下午 ${hour - 12} 点`;
  return `晚上 ${hour - 12} 点`;
}
