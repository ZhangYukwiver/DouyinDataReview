import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Alert,
  Linking,
  Platform,
  StyleSheet,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  ContentWorkspace,
  LegacyContentWorkspace,
  SetupWorkspace,
  StoryFrame,
  ensureThemeStyles,
  type LegacyWorkspaceViewKey,
  type RecordDownloadState,
  workspaceColors,
} from "./src/components/workspace";
import { buildPersonalSummary } from "./src/domain/annualReport";
import { buildLivingReport } from "./src/domain/livingReport";
import {
  describeArchiveInspection,
  type PersonalArchiveInspection,
} from "./src/domain/fileFormat";
import {
  countPersonalRecords,
  createEmptyPersonalRecords,
  type PersonalArchiveData,
  type PersonalRecordCollection,
  type PersonalVideoRecord,
} from "./src/domain/personalRecords";
import type { ChatConversationSummary, ChatMessage } from "./src/domain/chatRecords";
import {
  checkCollectorHealth,
  clearCollectorRecords,
  getCollectorPairingCode,
  getCollectorRecords,
  getCollectorStatus,
  getCollectorVideoDownload,
  getDefaultCollectorBaseUrl,
  LocalCollectorError,
  isChatReceiving,
  loadCollectorVideo,
  normalizeCollectorBaseUrl,
  parseLaunchPairingCode,
  pairCollector,
  startCollectorSync,
  startDirectRecordsSync,
  startCollectorObservation,
  startCollectorChatObservation,
  startCollectorVideoDownload,
  stopCollectorSync,
  stopCollectorObservation,
  stopCollectorChatObservation,
  switchCollectorAccount,
  fetchCollectorVideoFile,
  type CollectorSnapshot,
  type CollectorStatus,
  type VideoDownloadJob,
} from "./src/services/localCollector";
import {
  describePersonalArchiveError,
  importPersonalArchive,
} from "./src/services/importPersonalArchive";
import {
  checkDesktopUpdates,
  downloadDesktopUpdate,
  getDesktopCollectorConfig,
  getDesktopUpdateState,
  installDesktopUpdate,
  subscribeDesktopUpdateState,
  type DesktopUpdateState,
} from "./src/desktopRuntime";
import { shouldAutoSync } from "./src/services/autoSync";
import { createChatAutomaticRequestTracker, createChatStartupRequest } from "./src/services/chatStartup";
import { createSyncRecovery } from "./src/services/syncRecovery";
import { applyAppStyle, buildStoryEntryUrl, loadAppStyle, saveAppStyle, type AppStyle } from "./src/services/appStyle";
import { buildStoryData, clearStoryData, writeStoryData } from "./src/services/storyData";
import { buildReportModel } from "./src/components/workspace/ReportWorkspace";
import { ExploreWorkspace } from "./src/components/workspace/ExploreWorkspace";

type ViewKey = "summary" | "highlights" | "records" | "chat" | "sources";

const DOWNLOAD_JOB_POLL_INTERVAL_MS = 800;
const DOWNLOAD_JOB_TIMEOUT_MS = 15 * 60 * 1_000;

interface SelectedArchive {
  name: string;
  size: number | null;
  mimeType: string | null;
  inspection: PersonalArchiveInspection;
  data: PersonalArchiveData | null;
}

interface DisplaySnapshot {
  source: "collector" | "archive";
  records: PersonalRecordCollection;
  chatMessages: ChatMessage[];
  chatConversations: ChatConversationSummary[];
  warnings: string[];
  updatedAt: string | null;
}

interface CollectorConnectionOptions {
  baseUrl?: string;
  pairingCode?: string;
  revealSources?: boolean;
  automaticPairing?: boolean;
}

const TERMINAL_COLLECTOR_STATES = new Set(["idle", "complete", "partial", "error"]);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function triggerBrowserDownload(blob: Blob, fileName: string | null): void {
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof URL === "undefined") {
    throw new LocalCollectorError("download_unsupported", "当前平台不支持直接保存视频文件。请在桌面 Web 工作台中重试。");
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName?.trim() || "douyin-video.mp4";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }, 0);
}

function showAlert(title: string, message: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function confirmAlert(
  title: string,
  message: string,
  confirmText: string,
  onDecision: (confirmed: boolean) => void,
  destructive = false,
) {
  let settled = false;
  const settle = (confirmed: boolean) => {
    if (settled) return;
    settled = true;
    onDecision(confirmed);
  };
  if (Platform.OS === "web" && typeof window !== "undefined") {
    settle(window.confirm(`${title}\n\n${message}`));
    return;
  }
  Alert.alert(title, message, [
    { text: "取消", style: "cancel", onPress: () => settle(false) },
    { text: confirmText, style: destructive ? "destructive" : "default", onPress: () => settle(true) },
  ], { cancelable: true, onDismiss: () => settle(false) });
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function collectorErrorMessage(error: unknown): string {
  return error instanceof LocalCollectorError ? error.message : "本地采集服务暂时不可用。";
}

function opensExploreFromUrl(): boolean {
  return Platform.OS === "web" && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("workspace") === "explore";
}

function AppContent() {
  const [activeView, setActiveView] = useState<ViewKey>(() => opensExploreFromUrl() ? "summary" : "sources");
  const [dashboardOpen, setDashboardOpen] = useState(opensExploreFromUrl);
  const [dashboardView, setDashboardView] = useState<LegacyWorkspaceViewKey>(() => opensExploreFromUrl() ? "explore" : "summary");
  const [privacy, setPrivacy] = useState(false);
  const [selectedArchive, setSelectedArchive] = useState<SelectedArchive | null>(null);
  const [pickingArchive, setPickingArchive] = useState(false);
  const [collectorUrl, setCollectorUrl] = useState(getDefaultCollectorBaseUrl());
  const [pairingCode, setPairingCode] = useState("");
  const [collectorToken, setCollectorToken] = useState<string | null>(null);
  const [collectorStatus, setCollectorStatus] = useState<CollectorStatus | null>(null);
  const [collectorSnapshot, setCollectorSnapshot] = useState<CollectorSnapshot | null>(null);
  const [collectorBusy, setCollectorBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [stoppingSync, setStoppingSync] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [collectorError, setCollectorError] = useState<string | null>(null);
  const [downloadStates, setDownloadStates] = useState<Record<string, RecordDownloadState>>({});
  const [downloadJobs, setDownloadJobs] = useState<Record<string, VideoDownloadJob>>({});
  const [batchDownloadActive, setBatchDownloadActive] = useState(false);
  const [appStyle, setAppStyle] = useState<AppStyle>(loadAppStyle);
  const [appUpdate, setAppUpdate] = useState<DesktopUpdateState | null>(null);
  // 内容年志入口卡的地址；非空时以应用内 iframe 盖在工作台上（见 StoryFrame）
  const [storySrc, setStorySrc] = useState<string | null>(null);
  // 采集进行中，报告与内容库用这次采集开始前的快照；采集结束（busy 落下）再换成新数据
  const [frozenSnapshot, setFrozenSnapshot] = useState<CollectorSnapshot | null>(null);
  const importRequest = useRef(0);
  const pollRequest = useRef(0);
  const statusPollAbortRef = useRef<AbortController | null>(null);
  const downloadRequestRef = useRef(0);
  const downloadInFlightRef = useRef(new Set<string>());
  const connectingRef = useRef(false);
  const syncConfirmationOpenRef = useRef(false);
  const accountSwitchConfirmationOpenRef = useRef(false);
  const autoSyncInFlightRef = useRef(false);
  const autoSyncTriggerRef = useRef<() => void>(() => undefined);
  const chatStartupRef = useRef(createChatStartupRequest());
  // Keep the origin of the active chat run after take() consumes the
  // automatic startup request, so an asynchronous collector error can re-arm
  // only that automatic path.
  const chatAutomaticRequestRef = useRef(createChatAutomaticRequestTracker());
  const chatCollectionInFlightRef = useRef(false);
  const chatPollRequestRef = useRef<number | null>(null);
  const chatBusyRequestRef = useRef<number | null>(null);
  const syncRecoveryRef = useRef(createSyncRecovery());
  const appUpdateActionRef = useRef(false);

  // 只记录新增探索页的位置；刷新可直接回来，原有页面的启动流程保持不变。
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const exploring = activeView !== "sources" && dashboardOpen && dashboardView === "explore" && !storySrc;
    if (exploring) url.searchParams.set("workspace", "explore");
    else if (url.searchParams.get("workspace") === "explore") url.searchParams.delete("workspace");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [activeView, dashboardOpen, dashboardView, storySrc]);
  useEffect(() => () => {
    pollRequest.current += 1;
    statusPollAbortRef.current?.abort();
    importRequest.current += 1;
    chatStartupRef.current.cancel();
    chatAutomaticRequestRef.current.clear();
    chatCollectionInFlightRef.current = false;
    chatPollRequestRef.current = null;
    chatBusyRequestRef.current = null;
    downloadRequestRef.current += 1;
    downloadInFlightRef.current.clear();
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeDesktopUpdateState((state) => {
      if (active) setAppUpdate(state);
    });
    void getDesktopUpdateState().then((state) => {
      if (active && state) setAppUpdate(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function checkForAppUpdates() {
    if (appUpdateActionRef.current) return;
    appUpdateActionRef.current = true;
    try {
      const state = await checkDesktopUpdates();
      if (state) setAppUpdate(state);
    } finally {
      appUpdateActionRef.current = false;
    }
  }

  async function downloadAppUpdate() {
    if (appUpdateActionRef.current) return;
    appUpdateActionRef.current = true;
    try {
      const state = await downloadDesktopUpdate();
      if (state) setAppUpdate(state);
    } finally {
      appUpdateActionRef.current = false;
    }
  }

  async function installAppUpdate() {
    if (appUpdateActionRef.current) return;
    appUpdateActionRef.current = true;
    try {
      await installDesktopUpdate();
    } finally {
      appUpdateActionRef.current = false;
    }
  }

  // 整体风格：主题 CSS 变量挂在 <html data-style> 上，采集器页、内容库与持续报告一起换。
  // 用 layout effect 是为了在首帧绘制前就把变量表和 data-style 挂上，否则第一帧没有颜色。
  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    ensureThemeStyles();
    applyAppStyle(appStyle);
  }, [appStyle]);

  // 内容年志卷尾的「进入持续报告」与导航上的「工作台」从 iframe 里回到应用
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || (event.data as { type?: unknown } | null)?.type !== "trace:open-dashboard") return;
      setStorySrc(null);
      setDashboardView("summary");
      setDashboardOpen(true);
      setActiveView("summary");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return undefined;
    const styleId = "content-workspace-focus-styles";
    if (document.getElementById(styleId)) return undefined;
    const focusStyles = document.createElement("style");
    focusStyles.id = styleId;
    focusStyles.textContent = `
      button:focus-visible,
      input:focus-visible,
      [role="button"]:focus-visible,
      [role="tab"]:focus-visible,
      [role="switch"]:focus-visible,
      [role="link"]:focus-visible {
        outline: 2px solid ${workspaceColors.cyan} !important;
        outline-offset: 2px !important;
      }
      [data-focus-treatment="scale"]:focus-visible {
        outline: none !important;
        outline-offset: 0 !important;
        transform: scale(1.04);
      }
    `;
    document.head.appendChild(focusStyles);
    return () => focusStyles.remove();
  }, []);

  useEffect(() => {
    // 只在 busy 翻转时取值：翻成 true 的那一刻 collectorSnapshot 还是采集前的数据
    setFrozenSnapshot(collectorBusy ? collectorSnapshot : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectorBusy]);

  const shownSnapshot = frozenSnapshot ?? collectorSnapshot;
  const displaySnapshot: DisplaySnapshot | null = shownSnapshot
    ? {
        source: "collector",
        records: shownSnapshot.records,
        chatMessages: collectorSnapshot?.chatMessages ?? shownSnapshot.chatMessages,
        chatConversations: collectorSnapshot?.chatConversations ?? shownSnapshot.chatConversations,
        warnings: shownSnapshot.warnings,
        updatedAt: shownSnapshot.updatedAt,
      }
    : selectedArchive?.data
      ? {
          source: "archive",
          records: selectedArchive.data.records,
          chatMessages: [],
          chatConversations: [],
          warnings: selectedArchive.data.warnings,
          updatedAt: null,
        }
      : null;

  const personalSummary = useMemo(() => {
    if (!displaySnapshot) return null;
    const collectionState = displaySnapshot?.source === "collector"
      ? collectorStatus?.state === "complete"
        ? "complete"
        : collectorStatus && ["partial", "error", "collecting", "launching_browser", "awaiting_login", "observing"].includes(collectorStatus.state)
          ? "partial"
          : "unknown"
      : "unknown";
    return buildPersonalSummary(displaySnapshot.records, {
      source: displaySnapshot?.source,
      collectionState,
      warnings: displaySnapshot?.warnings ?? [],
    });
  }, [collectorStatus?.state, displaySnapshot?.records, displaySnapshot?.source, displaySnapshot?.warnings]);

  const livingReport = useMemo(() => {
    if (!displaySnapshot) return null;
    const collectionState = displaySnapshot.source === "collector"
      ? collectorStatus?.state === "complete"
        ? "complete"
        : collectorStatus && ["partial", "error", "collecting", "launching_browser", "awaiting_login", "observing"].includes(collectorStatus.state)
          ? "partial"
          : "unknown"
      : "unknown";
    return buildLivingReport(displaySnapshot.records, {
      source: displaySnapshot.source,
      sourceUpdatedAt: displaySnapshot.updatedAt,
      collectionState,
      warnings: displaySnapshot.warnings,
    });
  }, [collectorStatus?.state, displaySnapshot?.records, displaySnapshot?.source, displaySnapshot?.updatedAt, displaySnapshot?.warnings]);

  useEffect(() => {
    const trigger = () => autoSyncTriggerRef.current();
    if (Platform.OS === "web") {
      if (typeof document === "undefined") return undefined;
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") trigger();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (document.visibilityState === "visible") trigger();
      return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") trigger();
    });
    if (AppState.currentState === "active") trigger();
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (collectorToken && displaySnapshot?.source === "collector") autoSyncTriggerRef.current();
  }, [autoSyncEnabled, collectorToken, displaySnapshot?.source]);

  useEffect(() => {
    if (!collectorToken || displaySnapshot?.source !== "collector" || !chatStartupRef.current.isReady()) return undefined;
    if (collectorBusy || switchingAccount || autoSyncInFlightRef.current || chatCollectionInFlightRef.current) return undefined;
    if (collectorStatus && !TERMINAL_COLLECTOR_STATES.has(collectorStatus.state)) return undefined;

    // Resume reception after an operation that needs the shared browser.
    const timer = setTimeout(() => {
      if (!chatStartupRef.current.isReady() || !collectorToken || collectorBusy || switchingAccount || autoSyncInFlightRef.current || chatCollectionInFlightRef.current) return;
      void beginChatObservation(collectorUrl, collectorToken, true);
    }, 0);
    return () => clearTimeout(timer);
  }, [collectorBusy, collectorStatus?.state, collectorToken, collectorUrl, displaySnapshot?.source, switchingAccount]);

  async function refreshCollectorSnapshot(baseUrl: string, token: string, requestId?: number): Promise<boolean> {
    const snapshot = await getCollectorRecords(baseUrl, token);
    if (requestId !== undefined && pollRequest.current !== requestId) return false;
    setCollectorSnapshot(snapshot);
    return true;
  }

  async function pollCollector(baseUrl: string, token: string, requestId: number) {
    statusPollAbortRef.current?.abort();
    const controller = new AbortController();
    statusPollAbortRef.current = controller;
    // A shared record operation can replace the chat poll before the next
    // status response arrives. Bind that handoff immediately so an
    // asynchronous chat error is still attributed to the automatic run.
    if (chatAutomaticRequestRef.current.isActive()) chatAutomaticRequestRef.current.rebind(requestId);
    let revision: number | undefined;
    let snapshotVersion: string | undefined;
    try {
      while (pollRequest.current === requestId) {
        const status = await getCollectorStatus(baseUrl, token, revision, controller.signal);
        if (pollRequest.current !== requestId) return;
        revision = status.revision;
        setCollectorStatus(status);
        const chatPollOwnsRequest = chatPollRequestRef.current === requestId;
        const receiving = isChatReceiving(status);
        const automaticChatFailure = chatAutomaticRequestRef.current.matches(requestId)
          && status.chat.state === "error";
        // A record poll can replace the chat poll while the automatic chat
        // run is still starting. Treat its terminal error as belonging to
        // the chat operation for retry scheduling purposes.
        const chatOperation = chatPollOwnsRequest || automaticChatFailure;
        if (receiving) {
          // A direct-records poll can take over while the same chat run is
          // still alive. Keep both poll ids associated with that automatic
          // run so a later nested chat error can still re-arm it.
          chatAutomaticRequestRef.current.rebind(requestId);
          chatStartupRef.current.cancel();
          chatCollectionInFlightRef.current = true;
          chatPollRequestRef.current = requestId;
        }
        // 读取是边读边存的，计数或时间一变就把新快照取回来，不用等整轮结束
        const nextVersion = JSON.stringify([status.updatedAt, status.counts]);
        if (snapshotVersion !== nextVersion) {
          if (!await refreshCollectorSnapshot(baseUrl, token, requestId)) return;
          snapshotVersion = nextVersion;
        }
        if (pollRequest.current !== requestId) return;
        if (automaticChatFailure) {
          // The start endpoint may acknowledge the run before login or
          // navigation fails asynchronously in the collector. Handle the
          // nested chat terminal state even while a record task owns the
          // top-level collector state.
          setCollectorError(status.chat.message?.trim() || "聊天读取启动失败，请稍后重试。");
          chatStartupRef.current.defer();
          chatAutomaticRequestRef.current.takeFailure(requestId);
          chatCollectionInFlightRef.current = false;
          chatPollRequestRef.current = null;
        }
        if (status.state === "observing") setCollectorBusy(false);
        if (TERMINAL_COLLECTOR_STATES.has(status.state)) {
          setCollectorBusy(false);
          autoSyncInFlightRef.current = false;
          if (!receiving && chatPollRequestRef.current === requestId) {
            chatCollectionInFlightRef.current = false;
            chatPollRequestRef.current = null;
          }
          // 每次增量读取最多回退一次完整读取；完整读取失败时不重复启动。
          if (syncRecoveryRef.current.takeFallback(status)) {
            void beginSync(baseUrl, token);
            return;
          }
          if (!chatOperation && chatStartupRef.current.isPending()) chatStartupRef.current.retry();
          if (chatStartupRef.current.isReady() && !chatCollectionInFlightRef.current) {
            void beginChatObservation(baseUrl, token, true);
            return;
          }
          // 聊天还在接收就接着看着它，记录读取结束不代表没事可做了
          if (!receiving) return;
        }
        // Older collectors do not support a revision cursor.
        if (revision === undefined) await delay(1_000);
      }
    } catch (error) {
      if (pollRequest.current !== requestId || controller.signal.aborted) return;
      if (error instanceof LocalCollectorError && ["timeout", "unreachable"].includes(error.code)) {
        setCollectorBusy(false);
        setCollectorStatus((current) => current && isChatReceiving(current)
          ? { ...current, chatConnection: "reconnecting", chat: { ...current.chat, connection: "reconnecting" as const } }
          : current);
        await delay(1_500);
        if (pollRequest.current === requestId) void pollCollector(baseUrl, token, requestId);
        return;
      }
      setCollectorBusy(false);
      autoSyncInFlightRef.current = false;
      const automaticChatPollFailure = chatAutomaticRequestRef.current.matches(requestId);
      if (chatPollRequestRef.current === requestId || automaticChatPollFailure) {
        if (automaticChatPollFailure) {
          chatStartupRef.current.defer();
          chatAutomaticRequestRef.current.clear();
        } else {
          chatAutomaticRequestRef.current.clear(requestId);
        }
        chatCollectionInFlightRef.current = false;
        chatPollRequestRef.current = null;
      }
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert("无法读取同步状态", message);
    } finally {
      if (statusPollAbortRef.current === controller) statusPollAbortRef.current = null;
    }
  }

  function resetChatControlBusy() {
    chatBusyRequestRef.current = null;
    setChatBusy(false);
  }

  async function pauseChatForOperation(baseUrl: string, token: string, requestId: number) {
    if (!chatCollectionInFlightRef.current && !isChatReceiving(collectorStatus)) return true;
    chatStartupRef.current.request();
    chatAutomaticRequestRef.current.clear();
    // The operation already owns the latest poll request. Release the chat
    // control spinner immediately; the stop endpoint still drains the task
    // before the shared browser is reused.
    resetChatControlBusy();
    const status = await stopCollectorChatObservation(baseUrl, token);
    if (pollRequest.current !== requestId) return false;
    chatCollectionInFlightRef.current = false;
    chatPollRequestRef.current = null;
    setCollectorStatus(status);
    return true;
  }

  async function beginSync(baseUrl: string, token: string, incremental = false) {
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    syncRecoveryRef.current.begin(incremental);
    setCollectorBusy(true);
    setStoppingSync(false);
    setCollectorError(null);
    try {
      // 增量读取和聊天接收共用同一个无头会话，不用打断接收；完整读取要可见浏览器，才需要让位
      if (!incremental && !await pauseChatForOperation(baseUrl, token, requestId)) return;
      const status = incremental
        ? await startDirectRecordsSync(baseUrl, token)
        : await startCollectorSync(baseUrl, token);
      if (pollRequest.current !== requestId) return;
      setCollectorStatus(status);
      void pollCollector(baseUrl, token, requestId);
    } catch (error) {
      if (pollRequest.current !== requestId) return;
      setCollectorBusy(false);
      autoSyncInFlightRef.current = false;
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert(incremental ? "无法增量读取记录" : "无法完整读取记录", message);
    }
  }

  function triggerAutoSync() {
    if (batchDownloadActive) return;
    // Returning from the search browser must not close its result/verification
    // page to launch a foreground history sync.
    if (activeView !== "sources" && dashboardOpen && dashboardView === "explore" && !storySrc) return;
    const token = collectorToken;
    if (!token || !shouldAutoSync({
      enabled: autoSyncEnabled,
      connected: Boolean(token),
      source: displaySnapshot?.source ?? null,
      busy: collectorBusy,
      inFlight: autoSyncInFlightRef.current,
      switchingAccount,
      stoppingSync,
      state: collectorStatus?.phase === "chat_messages" && isChatReceiving(collectorStatus)
        ? "idle"
        : collectorStatus?.state ?? null,
    })) return;
    autoSyncInFlightRef.current = true;
    void beginSync(collectorUrl, token, true);
  }

  autoSyncTriggerRef.current = triggerAutoSync;

  // 聊天这条线自己的忙：正在起停、正在整理历史，或者可见浏览器被别的任务占着
  const chatControlBusy = chatBusy
    || (isChatReceiving(collectorStatus) && (
      (collectorStatus?.chat.state !== "idle" && collectorStatus?.chat.state !== "observing")
      || collectorStatus?.chat.progress !== null
    ))
    || (collectorStatus?.state === "observing" && !isChatReceiving(collectorStatus))
    || collectorStatus?.syncMode === "page";

  async function endSync(baseUrl: string, token: string) {
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    setCollectorBusy(true);
    setStoppingSync(true);
    setCollectorError(null);
    try {
      const status = await stopCollectorSync(baseUrl, token);
      if (pollRequest.current !== requestId) return;
      setCollectorStatus(status);
      if (TERMINAL_COLLECTOR_STATES.has(status.state)) {
        await refreshCollectorSnapshot(baseUrl, token, requestId);
        if (pollRequest.current !== requestId) return;
        autoSyncInFlightRef.current = false;
        if (chatStartupRef.current.isPending()) chatStartupRef.current.retry();
        setCollectorBusy(false);
      } else {
        await pollCollector(baseUrl, token, requestId);
      }
    } catch (error) {
      if (pollRequest.current !== requestId) return;
      setCollectorBusy(false);
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert("无法停止读取", message);
    } finally {
      if (pollRequest.current === requestId) setStoppingSync(false);
    }
  }

  async function beginObservation(baseUrl: string, token: string) {
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    setCollectorBusy(true);
    setCollectorError(null);
    try {
      if (!await pauseChatForOperation(baseUrl, token, requestId)) return;
      const status = await startCollectorObservation(baseUrl, token);
      if (pollRequest.current !== requestId) return;
      setCollectorStatus(status);
      void pollCollector(baseUrl, token, requestId);
    } catch (error) {
      if (pollRequest.current !== requestId) return;
      setCollectorBusy(false);
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert("无法启动手动监听", message);
    }
  }

  async function beginChatObservation(baseUrl: string, token: string, automatic = false) {
    if (chatCollectionInFlightRef.current || switchingAccount) return;
    if (automatic && !chatStartupRef.current.take()) return;
    chatCollectionInFlightRef.current = true;
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    chatPollRequestRef.current = requestId;
    if (automatic) chatAutomaticRequestRef.current.mark(requestId);
    else chatAutomaticRequestRef.current.clear();
    chatBusyRequestRef.current = requestId;
    setChatBusy(true);
    setCollectorError(null);
    try {
      const status = await startCollectorChatObservation(baseUrl, token);
      if (pollRequest.current !== requestId) {
        // A newer shared-browser poll will reconcile an automatic run's
        // eventual chat state. Explicit pause/disconnect paths clear this
        // tracker before superseding the request, so leave it intact here.
        if (automatic && chatAutomaticRequestRef.current.matches(requestId)) {
          if (!isChatReceiving(status)) chatStartupRef.current.defer();
        } else if (!automatic) {
          chatAutomaticRequestRef.current.clear(requestId);
        }
        if (chatPollRequestRef.current === requestId) {
          chatCollectionInFlightRef.current = false;
          chatPollRequestRef.current = null;
        }
        return;
      }
      setCollectorStatus(status);
      if (automatic && !isChatReceiving(status)) {
        // Preserve the automatic request, but wait for a later record/login
        // operation before retrying a terminal startup failure.
        chatStartupRef.current.defer();
        chatAutomaticRequestRef.current.clear();
      }
      void pollCollector(baseUrl, token, requestId);
    } catch (error) {
      if (pollRequest.current !== requestId) {
        if (automatic && chatAutomaticRequestRef.current.matches(requestId)) chatStartupRef.current.defer();
        if (!automatic) chatAutomaticRequestRef.current.clear(requestId);
        if (chatPollRequestRef.current === requestId) {
          chatCollectionInFlightRef.current = false;
          chatPollRequestRef.current = null;
        }
        return;
      }
      if (chatPollRequestRef.current === requestId) {
        chatCollectionInFlightRef.current = false;
        chatPollRequestRef.current = null;
      }
      if (automatic) chatStartupRef.current.defer();
      chatAutomaticRequestRef.current.clear();
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert("无法开始接收消息", message);
    } finally {
      finishChatControl(requestId);
    }
  }

  async function endObservation(baseUrl: string, token: string) {
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    setCollectorBusy(true);
    setCollectorError(null);
    try {
      const status = await stopCollectorObservation(baseUrl, token);
      if (pollRequest.current !== requestId) return;
      setCollectorStatus(status);
      await refreshCollectorSnapshot(baseUrl, token, requestId);
      if (pollRequest.current !== requestId) return;
      if (chatStartupRef.current.isPending()) chatStartupRef.current.retry();
      setCollectorBusy(false);
    } catch (error) {
      if (pollRequest.current !== requestId) return;
      setCollectorBusy(false);
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert("无法停止手动监听", message);
    }
  }

  async function endChatObservation(baseUrl: string, token: string): Promise<boolean> {
    chatStartupRef.current.cancel();
    chatAutomaticRequestRef.current.clear();
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    chatBusyRequestRef.current = requestId;
    setChatBusy(true);
    setCollectorError(null);
    try {
      const status = await stopCollectorChatObservation(baseUrl, token);
      if (pollRequest.current !== requestId) return false;
      setCollectorStatus(status);
      await refreshCollectorSnapshot(baseUrl, token, requestId);
      if (pollRequest.current !== requestId) return false;
      chatCollectionInFlightRef.current = false;
      chatPollRequestRef.current = null;
      // 记录读取可能还在跑，接着盯着它；没事做的话轮询自己会退出
      void pollCollector(baseUrl, token, requestId);
      return true;
    } catch (error) {
      if (pollRequest.current !== requestId) return false;
      chatCollectionInFlightRef.current = false;
      chatPollRequestRef.current = null;
      const message = collectorErrorMessage(error);
      setCollectorError(message);
      showAlert("无法暂停实时接收", message);
      return false;
    } finally {
      finishChatControl(requestId);
    }
  }

  function finishChatControl(requestId: number) {
    // Busy state belongs to the request that started the chat control. A
    // newer chat request or an explicit shared-browser operation may replace
    // it before the old promise settles; neither should clear the newer
    // request's spinner.
    if (chatBusyRequestRef.current !== requestId) return;
    chatBusyRequestRef.current = null;
    setChatBusy(false);
  }

  async function collectChatHistory(baseUrl: string, token: string) {
    if (switchingAccount || chatBusy) return;
    chatStartupRef.current.cancel();
    chatAutomaticRequestRef.current.clear();
    // The collector's chat endpoint performs the history sweep only when a
    // run starts. Restart an existing run so this explicit action really
    // re-collects history, then let the same run continue receiving pushes.
    if (chatCollectionInFlightRef.current || isChatReceiving(collectorStatus)) {
      if (!await endChatObservation(baseUrl, token)) return;
    }
    if (collectorStatus?.state === "observing" && !isChatReceiving(collectorStatus)) return;
    await beginChatObservation(baseUrl, token);
  }

  async function connectCollector(options: CollectorConnectionOptions = {}) {
    if (collectorToken || connectingRef.current) return;
    connectingRef.current = true;
    let requestedUrl = options.baseUrl ?? collectorUrl;
    let requestedPairingCode = options.pairingCode ?? pairingCode;
    const revealSources = options.revealSources ?? true;
    if (revealSources) setActiveView("sources");
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    let normalizedUrl: string | null = null;
    let pairedToken: string | null = null;
    let healthChecked = false;
    setCollectorBusy(true);
    setCollectorError(null);
    try {
      if (options.automaticPairing) {
        const desktopConfig = await getDesktopCollectorConfig();
        if (desktopConfig) {
          requestedUrl = desktopConfig.baseUrl;
          requestedPairingCode = desktopConfig.pairingCode;
        } else {
          let launchCode: string | null = null;
          if (Platform.OS === "web" && typeof window !== "undefined") {
            const hostname = window.location.hostname.replace(/^\[|\]$/gu, "");
            launchCode = ["localhost", "127.0.0.1", "::1"].includes(hostname)
              ? parseLaunchPairingCode(window.location.hash)
              : null;
            if (launchCode) {
              window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
            }
          }

          normalizedUrl = normalizeCollectorBaseUrl(requestedUrl);
          await checkCollectorHealth(normalizedUrl);
          healthChecked = true;
          if (launchCode) {
            requestedPairingCode = launchCode;
          } else {
            try {
              requestedPairingCode = await getCollectorPairingCode(normalizedUrl);
            } catch (error) {
              if (!/^\d{8}$/u.test(pairingCode.trim())) throw error;
              requestedPairingCode = pairingCode.trim();
            }
          }
        }
        if (pollRequest.current !== requestId) return;
        setCollectorUrl(requestedUrl);
        setPairingCode(requestedPairingCode);
      }

      normalizedUrl ??= normalizeCollectorBaseUrl(requestedUrl);
      if (!healthChecked) await checkCollectorHealth(normalizedUrl);
      pairedToken = await pairCollector(normalizedUrl, requestedPairingCode);
      if (pollRequest.current !== requestId) return;
      setCollectorUrl(normalizedUrl);
      setCollectorToken(pairedToken);
      setPairingCode("");
      const [status, snapshot] = await Promise.all([
        getCollectorStatus(normalizedUrl, pairedToken),
        getCollectorRecords(normalizedUrl, pairedToken),
      ]);
      if (pollRequest.current !== requestId) return;
      setCollectorUrl(normalizedUrl);
      setCollectorStatus(status);
      setCollectorSnapshot(snapshot);
      clearStoryData();
      if (isChatReceiving(status)) {
        chatStartupRef.current.cancel();
        chatAutomaticRequestRef.current.clear();
        chatCollectionInFlightRef.current = true;
        chatPollRequestRef.current = requestId;
      } else {
        chatStartupRef.current.request();
      }
      if (TERMINAL_COLLECTOR_STATES.has(status.state) && !isChatReceiving(status)) {
        setCollectorBusy(false);
      } else {
        void pollCollector(normalizedUrl, pairedToken, requestId);
      }
    } catch (error) {
      if (pollRequest.current !== requestId) return;
      if (!pairedToken) {
        chatStartupRef.current.cancel();
        chatAutomaticRequestRef.current.clear();
      }
      chatCollectionInFlightRef.current = false;
      chatPollRequestRef.current = null;
      setCollectorBusy(false);
      const message = collectorErrorMessage(error);
      setCollectorError(pairedToken
        ? `${message} 配对已完成，稍后可从此页面继续操作。`
        : message);
      setActiveView("sources");
    } finally {
      connectingRef.current = false;
    }
  }

  function confirmFullSync() {
    if (!collectorToken || collectorBusy || (collectorStatus?.state === "observing" && !isChatReceiving(collectorStatus)) || syncConfirmationOpenRef.current) return;
    syncConfirmationOpenRef.current = true;
    confirmAlert(
      "开始读取全部可见记录",
      "将由专用浏览器依次打开观看、点赞和收藏列表，并持续滚动到各列表当前可见的末页。",
      "开始",
      (confirmed) => {
        syncConfirmationOpenRef.current = false;
        if (confirmed) void beginSync(collectorUrl, collectorToken);
      },
    );
  }

  function confirmIncrementalSync() {
    if (!collectorToken || collectorBusy || (collectorStatus?.state === "observing" && !isChatReceiving(collectorStatus)) || syncConfirmationOpenRef.current) return;
    syncConfirmationOpenRef.current = true;
    confirmAlert(
      "增量读取",
      "尚未建立边界的分类会读取全部可见记录；已有边界的分类只读取到本地已知记录为止。正常运行时不会弹出浏览器；如果增量配置尚未初始化或已失效，应用会先完成一次完整读取来建立配置。",
      "读取新记录",
      (confirmed) => {
        syncConfirmationOpenRef.current = false;
        if (confirmed) void beginSync(collectorUrl, collectorToken, true);
      },
    );
  }

  async function disconnectCollector() {
    const token = collectorToken;
    if (!token) return;
    pollRequest.current += 1;
    downloadRequestRef.current += 1;
    downloadInFlightRef.current.clear();
    autoSyncInFlightRef.current = false;
    chatStartupRef.current.cancel();
    chatAutomaticRequestRef.current.clear();
    chatCollectionInFlightRef.current = false;
    chatPollRequestRef.current = null;
    chatBusyRequestRef.current = null;
    resetChatControlBusy();
    setCollectorBusy(true);
    let stopError: string | null = null;
    try {
      await stopCollectorObservation(collectorUrl, token);
      await stopCollectorChatObservation(collectorUrl, token);
    } catch (error) {
      stopError = collectorErrorMessage(error);
    } finally {
      setCollectorToken(null);
      setCollectorStatus(null);
      setCollectorSnapshot(null);
      setStoppingSync(false);
      setCollectorBusy(false);
      setDownloadStates({});
      setDownloadJobs({});
      setCollectorError(stopError
        ? `已断开应用，但无法确认采集任务已停止：${stopError}`
        : null);
    }
  }

  async function performAccountSwitch() {
    if (!collectorToken || switchingAccount || collectorBusy) return;
    const requestId = pollRequest.current + 1;
    pollRequest.current = requestId;
    downloadRequestRef.current += 1;
    downloadInFlightRef.current.clear();
    autoSyncInFlightRef.current = false;
    chatStartupRef.current.cancel();
    chatAutomaticRequestRef.current.clear();
    chatCollectionInFlightRef.current = false;
    chatPollRequestRef.current = null;
    resetChatControlBusy();
    setSwitchingAccount(true);
    setCollectorBusy(true);
    setCollectorError(null);
    setCollectorSnapshot(null);
    setDownloadStates({});
    setDownloadJobs({});
    try {
      const status = await switchCollectorAccount(collectorUrl, collectorToken);
      if (pollRequest.current !== requestId) return;
      setCollectorStatus(status);
      if (!await refreshCollectorSnapshot(collectorUrl, collectorToken, requestId)) return;
      clearStoryData();
      chatStartupRef.current.request();
      chatAutomaticRequestRef.current.clear();
      setActiveView("records");
      void pollCollector(collectorUrl, collectorToken, requestId);
    } catch (error) {
      if (pollRequest.current !== requestId) return;
      const message = collectorErrorMessage(error);
      setCollectorBusy(false);
      setCollectorError(message);
      showAlert("无法切换账号", message);
    } finally {
      setSwitchingAccount(false);
    }
  }

  function confirmAccountSwitch() {
    if (accountSwitchConfirmationOpenRef.current) return;
    accountSwitchConfirmationOpenRef.current = true;
    confirmAlert(
      "切换抖音账号",
      "将清除专用浏览器的登录会话和本地采集结果，随后打开专用浏览器进入手动监听，等待你登录新账号。不会影响抖音账号中的记录。",
      "切换",
      (confirmed) => {
        accountSwitchConfirmationOpenRef.current = false;
        if (confirmed) void performAccountSwitch();
      },
    );
  }

  async function pickArchive() {
    const requestId = importRequest.current + 1;
    importRequest.current = requestId;
    setPickingArchive(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
        multiple: false,
        base64: false,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const archive: SelectedArchive = {
          name: asset.name,
          size: asset.size ?? null,
          mimeType: asset.mimeType ?? null,
          inspection: { status: "inspecting" },
          data: null,
        };
        setSelectedArchive(archive);
        try {
          const data = await importPersonalArchive(asset);
          if (importRequest.current !== requestId) return;
          clearStoryData();
          setSelectedArchive({ ...archive, inspection: { status: "complete", format: data.format }, data });
        } catch (error) {
          if (importRequest.current !== requestId) return;
          setSelectedArchive({ ...archive, inspection: { status: "failed" } });
          showAlert("无法读取备用文件", describePersonalArchiveError(error));
        }
      }
    } catch {
      showAlert("无法选择文件", "请检查文件访问权限后重试。");
    } finally {
      if (importRequest.current === requestId) setPickingArchive(false);
    }
  }

  function clearCurrentRecords() {
    confirmAlert(
      "清除本地缓存",
      "将清除本地保存的观看、喜欢和收藏记录。抖音登录状态、Cookie 和账号中的记录不会受影响；下一次读取将重新获取全部可见记录。",
      "清除缓存",
      (confirmed) => {
        if (!confirmed) return;
        autoSyncInFlightRef.current = false;
        clearStoryData();
        if (collectorToken) {
          chatStartupRef.current.request();
          chatAutomaticRequestRef.current.clear();
          chatCollectionInFlightRef.current = false;
          chatPollRequestRef.current = null;
          resetChatControlBusy();
          const requestId = pollRequest.current + 1;
          const token = collectorToken;
          pollRequest.current = requestId;
          setCollectorBusy(true);
          setCollectorError(null);
          void (async () => {
            try {
              const snapshot = await clearCollectorRecords(collectorUrl, token);
              if (pollRequest.current !== requestId) return;
              setCollectorSnapshot(snapshot);
              const status = await getCollectorStatus(collectorUrl, token);
              if (pollRequest.current !== requestId) return;
              setCollectorStatus(status);
            } catch (error) {
              if (pollRequest.current !== requestId) return;
              const message = collectorErrorMessage(error);
              setCollectorError(message);
              showAlert("无法清除记录", message);
            } finally {
              if (pollRequest.current === requestId) setCollectorBusy(false);
            }
          })();
        } else {
          importRequest.current += 1;
          setSelectedArchive(null);
        }
      },
      true,
    );
  }

  async function openRecord(url: string) {
    try {
      if (!(await Linking.canOpenURL(url))) throw new Error("unsupported_url");
      await Linking.openURL(url);
    } catch {
      showAlert("无法打开视频", "该记录中的链接当前不可用。");
    }
  }

  async function loadRecordVideo(record: PersonalVideoRecord, signal: AbortSignal, onProgress?: (message: string) => void): Promise<Blob> {
    if (!record.url) throw new LocalCollectorError("invalid_url", "该记录没有可用的抖音链接。");
    if (!collectorToken) {
      throw new LocalCollectorError("not_paired", "请先在“连接与采集”页面连接本地采集服务，再播放视频。");
    }
    return loadCollectorVideo(collectorUrl, collectorToken, record.url, signal, onProgress);
  }

  function rememberDownloadJob(recordId: string, job: VideoDownloadJob) {
    setDownloadJobs((current) => ({ ...current, [recordId]: job }));
    setDownloadStates((current) => ({ ...current, [recordId]: job.status }));
  }

  function markDownloadState(recordId: string, state: RecordDownloadState) {
    setDownloadStates((current) => ({ ...current, [recordId]: state }));
  }

  async function downloadRecord(record: PersonalVideoRecord): Promise<void> {
    if (Platform.OS !== "web") {
      showAlert("暂不支持下载", "请在桌面 Web 工作台中将视频保存到本地。");
      return;
    }
    const sourceUrl = record.url?.trim();
    if (!sourceUrl) {
      showAlert("无法下载视频", "该记录没有可用的抖音链接。");
      return;
    }
    const token = collectorToken;
    const baseUrl = collectorUrl;
    if (!token) {
      showAlert("需要连接采集器", "请先在“连接与采集”页面连接本地采集服务，再下载视频。");
      return;
    }
    if (downloadInFlightRef.current.has(record.id)) return;
    const existing = downloadJobs[record.id];
    if (existing?.status === "queued" || existing?.status === "running") return;

    const requestId = downloadRequestRef.current;
    downloadInFlightRef.current.add(record.id);
    markDownloadState(record.id, "queued");
    try {
      let job = await startCollectorVideoDownload(baseUrl, token, sourceUrl);
      if (downloadRequestRef.current !== requestId) return;
      rememberDownloadJob(record.id, job);

      const deadline = Date.now() + DOWNLOAD_JOB_TIMEOUT_MS;
      while (job.status === "queued" || job.status === "running") {
        if (Date.now() >= deadline) {
          throw new LocalCollectorError("timeout", "视频下载超时，请稍后重试。");
        }
        await delay(DOWNLOAD_JOB_POLL_INTERVAL_MS);
        if (downloadRequestRef.current !== requestId) return;
        job = await getCollectorVideoDownload(baseUrl, token, job.id);
        if (downloadRequestRef.current !== requestId) return;
        rememberDownloadJob(record.id, job);
      }
      if (job.status !== "complete") {
        throw new LocalCollectorError(job.errorCode ?? "download_failed", job.error ?? "视频下载失败，请稍后重试。");
      }

      const file = await fetchCollectorVideoFile(baseUrl, token, job.id);
      if (downloadRequestRef.current !== requestId) return;
      triggerBrowserDownload(file.blob, file.fileName ?? job.fileName);
      markDownloadState(record.id, "complete");
    } catch (error) {
      if (downloadRequestRef.current !== requestId) return;
      markDownloadState(record.id, "failed");
      setDownloadJobs((current) => {
        const previous = current[record.id];
        if (!previous) return current;
        return {
          ...current,
          [record.id]: {
            ...previous,
            status: "failed",
            errorCode: error instanceof LocalCollectorError ? error.code : "download_failed",
            error: error instanceof LocalCollectorError ? error.message : "视频下载失败，请稍后重试。",
            updatedAt: new Date().toISOString(),
          },
        };
      });
      showAlert("下载失败", error instanceof LocalCollectorError ? error.message : "视频下载失败，请稍后重试。");
    } finally {
      downloadInFlightRef.current.delete(record.id);
    }
  }

  const workspaceRecords = displaySnapshot?.records ?? createEmptyPersonalRecords();
  const sourceLabel = displaySnapshot?.source === "collector"
    ? "本地浏览器采集"
    : displaySnapshot?.source === "archive"
      ? "备用文件导入"
      : "本地内容";
  const archiveInfo = selectedArchive
    ? {
        name: selectedArchive.name,
        detail: selectedArchive.data
          ? `${countPersonalRecords(selectedArchive.data.records)} 条记录 | ${formatBytes(selectedArchive.size)}`
          : describeArchiveInspection(selectedArchive.inspection),
      }
    : null;

  const traceMode = appStyle === "trace" && Platform.OS === "web";

  function enterWorkspace() {
    if (traceMode) {
      // The story pages are static HTML under /story, shown in a same-origin iframe so this session's
      // collector token and records stay alive. They read one aggregated snapshot from localStorage.
      const chatMessages = displaySnapshot?.chatMessages ?? [];
      const chatConversations = displaySnapshot?.chatConversations ?? [];
      const source = displaySnapshot?.source ?? "archive";
      const model = buildReportModel(workspaceRecords, chatMessages, personalSummary ?? livingReport, chatConversations);
      const story = buildStoryData(model, {
        records: workspaceRecords,
        chatMessages,
        chatConversations,
        source,
        updatedAt: displaySnapshot?.updatedAt ?? null,
        warnings: displaySnapshot?.warnings ?? [],
        archive: source === "archive" && selectedArchive?.data ? { parsedFileCount: selectedArchive.data.parsedFileCount, ignoredFileCount: selectedArchive.data.ignoredFileCount } : null,
      });
      writeStoryData(story);
      setStorySrc(buildStoryEntryUrl({
        watch: workspaceRecords.watch_history.length,
        liked: workspaceRecords.liked_videos.length,
        favorite: workspaceRecords.favorite_videos.length,
        chat: collectorStatus?.counts.chat_messages ?? null,
      }, story.year, { motion: "full" }));
      return;
    }
    setDashboardOpen(false);
    setActiveView("summary");
  }

  function replayStory() {
    if (traceMode) {
      enterWorkspace();
      return;
    }
    setDashboardOpen(false);
    setActiveView("summary");
  }

  function openDashboard() {
    setStorySrc(null);
    setDashboardView("summary");
    setDashboardOpen(true);
    setActiveView("summary");
  }

  function openSettings() {
    setStorySrc(null);
    setDashboardOpen(false);
    setActiveView("sources");
  }

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
      <StatusBar style="light" />
      {activeView === "sources" ? (
        <SetupWorkspace
          archive={archiveInfo}
          busy={collectorBusy}
          collectorUrl={collectorUrl}
          connected={collectorToken !== null}
          error={collectorError}
          onChangeCollectorUrl={(value) => {
            setCollectorUrl(value);
            setCollectorError(null);
          }}
          onChangePairingCode={(value) => {
            setPairingCode(value);
            setCollectorError(null);
          }}
          onClearCache={clearCurrentRecords}
          onConnect={() => connectCollector({ automaticPairing: true })}
          onDisconnect={disconnectCollector}
          onEnterWorkspace={enterWorkspace}
          onOpenDashboard={openDashboard}
          onPickArchive={pickArchive}
          onStartIncrementalSync={confirmIncrementalSync}
          onStartObservation={() => collectorToken ? beginObservation(collectorUrl, collectorToken) : Promise.resolve()}
          onStartChatObservation={() => {
            chatStartupRef.current.cancel();
            chatAutomaticRequestRef.current.clear();
            return collectorToken ? beginChatObservation(collectorUrl, collectorToken) : Promise.resolve();
          }}
          onCollectChatHistory={() => collectorToken
            ? collectChatHistory(collectorUrl, collectorToken)
            : Promise.resolve()}
          onStartFullSync={confirmFullSync}
          onStopSync={() => collectorToken ? endSync(collectorUrl, collectorToken) : Promise.resolve()}
          onStopObservation={async () => {
            if (!collectorToken) return;
            if (isChatReceiving(collectorStatus)) {
              await endChatObservation(collectorUrl, collectorToken);
            } else if (collectorStatus?.state === "observing") {
              await endObservation(collectorUrl, collectorToken);
            } else {
              await endChatObservation(collectorUrl, collectorToken);
            }
          }}
          onSwitchAccount={confirmAccountSwitch}
          autoSyncEnabled={autoSyncEnabled}
          onToggleAutoSync={() => setAutoSyncEnabled((value) => !value)}
          appStyle={appStyle}
          onChangeAppStyle={(style) => {
            setAppStyle(style);
            saveAppStyle(style);
          }}
          chatBusy={chatControlBusy}
          chatCollecting={isChatReceiving(collectorStatus)}
          observing={collectorStatus?.state === "observing" && !isChatReceiving(collectorStatus)}
          pairingCode={pairingCode}
          pickingArchive={pickingArchive}
          records={workspaceRecords}
          snapshotSource={displaySnapshot?.source ?? null}
          snapshotUpdatedAt={displaySnapshot?.updatedAt ?? null}
          status={collectorStatus}
          stoppingSync={stoppingSync}
          switchingAccount={switchingAccount}
          appUpdate={appUpdate}
          onCheckAppUpdate={checkForAppUpdates}
          onDownloadAppUpdate={downloadAppUpdate}
          onInstallAppUpdate={installAppUpdate}
        />
      ) : dashboardOpen || traceMode ? (
        <LegacyContentWorkspace
          explore={<ExploreWorkspace connection={collectorToken ? { baseUrl: collectorUrl, token: collectorToken } : null} collectorBusy={collectorBusy} onOpenSettings={openSettings} onOpenRecord={openRecord} />}
          activeView={dashboardView}
          appStyle={appStyle}
          busy={collectorBusy}
          chatConversations={displaySnapshot?.chatConversations ?? []}
          chatMessages={displaySnapshot?.chatMessages ?? []}
          chatBusy={chatControlBusy}
          chatConnected={collectorToken !== null}
          onToggleChatReception={() => {
            if (!collectorToken) { openSettings(); return; }
            chatStartupRef.current.cancel();
            chatAutomaticRequestRef.current.clear();
            void (isChatReceiving(collectorStatus)
              ? endChatObservation(collectorUrl, collectorToken)
              : beginChatObservation(collectorUrl, collectorToken));
          }}
          onCollectChatHistory={() => {
            if (!collectorToken) { openSettings(); return; }
            void collectChatHistory(collectorUrl, collectorToken);
          }}
          onChangeView={setDashboardView}
          onDownloadRecord={downloadRecord}
          onBatchDownloadActiveChange={setBatchDownloadActive}
          onLoadVideo={loadRecordVideo}
          commentsConnection={collectorToken ? { baseUrl: collectorUrl, token: collectorToken } : null}
          onOpenRecord={openRecord}
          onOpenSettings={openSettings}
          onReplayStory={replayStory}
          onSync={() => collectorToken ? confirmIncrementalSync() : openSettings()}
          onTogglePrivacy={() => setPrivacy((value) => !value)}
          privacy={privacy}
          records={workspaceRecords}
          downloadStates={downloadStates}
          report={personalSummary ?? livingReport}
          sourceLabel={sourceLabel}
          status={collectorStatus}
          updatedAt={displaySnapshot?.updatedAt ?? null}
        />
      ) : (
        <ContentWorkspace
          activeView={activeView === "chat" ? "chat" : activeView === "highlights" ? "highlights" : "summary"}
          busy={collectorBusy}
          onOpenDashboard={openDashboard}
          onChangeView={(view) => {
            if (view === "summary" || view === "highlights" || view === "chat") {
              setActiveView(view);
              return;
            }
            setActiveView("summary");
          }}
          onOpenRecord={openRecord}
          onOpenSettings={openSettings}
          onReplayStory={replayStory}
          onSync={() => collectorToken ? confirmIncrementalSync() : setActiveView("sources")}
          onTogglePrivacy={() => setPrivacy((value) => !value)}
          privacy={privacy}
          records={workspaceRecords}
          chatMessages={displaySnapshot?.chatMessages ?? []}
          chatConversations={displaySnapshot?.chatConversations ?? []}
          report={personalSummary ?? livingReport}
          sourceLabel={sourceLabel}
          status={collectorStatus}
          updatedAt={displaySnapshot?.updatedAt ?? null}
        />
      )}
      {storySrc && traceMode ? <StoryFrame src={storySrc} /> : null}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: workspaceColors.canvas },
});
