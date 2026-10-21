import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator, FlatList, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View,
  type LayoutChangeEvent,
} from "react-native";
import {
  Check, ChevronDown, Film, FolderInput, FolderOpen, Library, Music2, Pause, Play, Plus, Scissors, Send, Settings2, SlidersHorizontal,
  Sparkles, Square, Sticker, Trash2, Type, X,
} from "lucide-react-native";
import type { PersonalRecordCollection, PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreConnection } from "../../services/explorer";
import {
  aiEditLookUrl, aiEditMediaUrl, answerAiEditLook, createAiEditSession, deleteAiEditMedia, deleteAiEditSession, exportAiEditSession, getAiEditDraftBox, getAiEditSession,
  importDouyinMedia, listAiEditMedia, listAiEditSessions, loadAiEditConfig, probeAiEditVideo, saveAiEditConfig, sendAiEditMessage, sessionRunning,
  stopAiEditSession, uploadAiEditMedia, videoProbeKey,
  type AiEditAction, type AiEditChatItem, type AiEditConfig, type AiEditDraftBoxStatus, type AiEditMediaItem, type AiEditSession, type AiEditSessionState,
  type AiEditSessionSummary, type EditCanvas, type EditMediaSegment, type EditProject, type EditSegment, type EditTextSegment, type EditTrack,
} from "../../services/aiEdit";
import { searchRecords } from "../../services/recordSearch";
import {
  activeFrame, blendMode, clipDetail, clipExtras, draftBoxReasonText, clipLabel, clipPosition, colorFilter, cropClipPath, cssTransform, effectiveTransform, featureName,
  filmstripCount, filmstripTimes, findSegment, formatClock, formatDuration, hasScaleKeyframes, layerBox, layerRect, maskCss, mediaIdFromPath, mediaThumbView, mediaVolume,
  nextSegmentAfter, playbackRate, projectDuration, rgba, rulerTicks, secondMark, sourceTimeUs, spokenDuration, textCss, timeAtX, trackLabel, transitionReach, US_PER_SECOND, visibleExportNote,
  type ClipDetail, type ExportNote, type MaskSpec, type Size, type TransitionReach,
} from "./aiEditModel";
import { createFrameQueue, openVideoFrames } from "./aiEditFrames";
import { dropLookJobs, runLookJob } from "./aiEditLook";
import { createUploadQueue } from "./aiEditUploads";
import { kit, Segmented, SmallButton } from "./CreatorKit";
import { Markdown } from "./markdownView";
import { ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 剪辑：左边和 AI 对话（会话、素材库、输入框），右边是只读的剪辑看板（画面预览 + 轨道）。
// 会话、工程、素材都在采集器里（collector/aiEdit/），页面只看和发消息；切走再回来按采集器的状态恢复。

type Props = { connection: ExploreConnection | null; records: PersonalRecordCollection; onOpenSettings: () => void };

const web = Platform.OS === "web";
const webPointer = web ? ({ cursor: "pointer" } as object) : null;
const webAutoHeight = web ? ({ fieldSizing: "content" } as object) : null;
const LAST_SESSION_KEY = "dy2.aiEditSession";
const errorText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;
// 上传不随页面卸载中断：切到别的侧栏再回来，进度和失败提示都接得上
// 测模型能不能看视频：整个页面共用，切走再回来不重复测（probing 正在测的、probeTried 自动测过的「地址|模型|Key」）
const probing = new Set<string>();
const probeTried = new Set<string>();
const uploadQueue = createUploadQueue(uploadAiEditMedia, (reason) => errorText(reason, "没传上去，请稍后重试。"));
// 轨道上视频片段的缩略图：全页一条取帧队列，结果缓存在模块里，切走再回来不用重新解码
const frameQueue = createFrameQueue(openVideoFrames);

function readLastSession(): string | null {
  try { return globalThis.localStorage?.getItem(LAST_SESSION_KEY) ?? null; } catch { return null; }
}
function rememberSession(id: string | null) {
  try {
    if (id) globalThis.localStorage?.setItem(LAST_SESSION_KEY, id);
    else globalThis.localStorage?.removeItem(LAST_SESSION_KEY);
  } catch { /* 记不住就下次进来选最近的 */ }
}

const CANVASES: Array<{ label: string; canvas: EditCanvas }> = [
  { label: "竖屏 9:16", canvas: { width: 1080, height: 1920, fps: 30 } },
  { label: "横屏 16:9", canvas: { width: 1920, height: 1080, fps: 30 } },
  { label: "方形 1:1", canvas: { width: 1080, height: 1080, fps: 30 } },
];

const SUGGESTIONS = [
  "把素材库里的视频剪成 30 秒的竖屏短片，配上字幕",
  "从我点赞的视频里挑 3 条讲美食的，剪成一个合集",
  "每段之间加转场，开头淡入、结尾淡出",
];

function AiEditWorkspaceImpl({ connection, records, onOpenSettings }: Props) {
  const baseUrl = connection?.baseUrl ?? null;
  const token = connection?.token ?? null;
  const conn = useMemo(() => (baseUrl && token ? { baseUrl, token } : null), [baseUrl, token]);
  const { width } = useWindowDimensions();
  const leftWidth = width >= 1280 ? 340 : 300;

  const [sessions, setSessions] = useState<AiEditSessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [state, setState] = useState<AiEditSessionState | null>(null);
  const [media, setMedia] = useState<AiEditMediaItem[]>([]);
  const [mediaKey, setMediaKey] = useState("");
  const uploads = useSyncExternalStore(uploadQueue.subscribe, uploadQueue.getSnapshot);
  const [config, setConfig] = useState<AiEditConfig>(loadAiEditConfig);
  const [configOpen, setConfigOpen] = useState(() => !loadAiEditConfig().apiKey);
  // 测模型能不能直接看视频：key 是测的哪个接口地址+模型，running 时在测，error 是没测出来的原因
  const [probe, setProbe] = useState<{ key: string; running: boolean; error?: string }>({ key: "", running: false });
  const [draftBox, setDraftBox] = useState<AiEditDraftBoxStatus | null>(null);
  // 导入状态按会话记：导入途中切到别的剪辑，那边的按钮和状态行不受影响，结果也只回到发起导入的那个剪辑
  const [exportingIds, setExportingIds] = useState<string[]>([]);
  const [exportNotes, setExportNotes] = useState<Record<string, ExportNote>>({});
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mediaUrl = useCallback((id: string) => (baseUrl && mediaKey ? aiEditMediaUrl(baseUrl, id, mediaKey) : null), [baseUrl, mediaKey]);

  const session = state?.session.id === currentId ? state.session : null;
  const project = state?.session.id === currentId ? state.project : null;
  const running = sessionRunning(session) || sending;
  const exporting = currentId ? exportingIds.includes(currentId) : false;
  const exportNote = visibleExportNote(currentId ? exportNotes[currentId] : null, project?.revision);

  // ---------- 会话列表：进页面时选上次看的那个，没有就选最近的 ----------
  const loadSessions = useCallback(async (prefer?: string | null) => {
    if (!conn) return;
    try {
      const list = sortSessions(await listAiEditSessions(conn));
      setSessions(list);
      setCurrentId((current) => {
        const wanted = prefer !== undefined ? prefer : current ?? readLastSession();
        return list.find((item) => item.id === wanted)?.id ?? list[0]?.id ?? null;
      });
    } catch (reason) {
      setError(errorText(reason, "最近的剪辑没读到，请稍后重试。"));
    } finally {
      setSessionsLoaded(true);
    }
  }, [conn]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { if (currentId) rememberSession(currentId); }, [currentId]);

  // 长轮询只盯着当前这个剪辑；切走的剪辑在后台跑完、被 AI 改名，菜单打开时重读一遍才看得到。
  // 菜单开着、列表里还有「AI 正在剪」的，就每 3 秒再看一次。读不到就先显示上次的，不报错
  const refreshSessions = useCallback(async () => {
    if (!conn) return;
    try { setSessions(sortSessions(await listAiEditSessions(conn))); } catch { /* 菜单先显示上次读到的 */ }
  }, [conn]);
  const someRunning = sessions.some((item) => item.status === "running");
  useEffect(() => {
    if (!menuOpen) return undefined;
    void refreshSessions();
    if (!someRunning) return undefined;
    const timer = setInterval(() => void refreshSessions(), 3000);
    return () => clearInterval(timer);
  }, [menuOpen, someRunning, refreshSessions]);

  // ---------- 当前会话长轮询：采集器最多挂 8 秒，会话一变立刻回来 ----------
  // 连续失败时报的那条错误记下来，连上了就撤掉（别的地方报的错不动）
  const pollError = useRef<string | null>(null);
  useEffect(() => {
    if (!conn || !currentId) return undefined;
    const controller = new AbortController();
    let revision: number | undefined;
    let failures = 0;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const next = await getAiEditSession(conn, currentId, revision, controller.signal);
          if (controller.signal.aborted) return;
          failures = 0;
          revision = next.session.revision;
          setState(next);
          setSessions((list) => list.map((item) => item.id === next.session.id ? summaryOf(next.session) : item));
          const stale = pollError.current;
          if (stale) { pollError.current = null; setError((current) => current === stale ? null : current); }
        } catch (reason) {
          if (controller.signal.aborted) return;
          const code = (reason as { code?: string }).code ?? "";
          if (/not_found|http_404/u.test(code)) { void loadSessions(null); return; }
          failures += 1;
          if (failures >= 3) {
            const text = errorText(reason, "和采集器的连接断了，正在重试。");
            pollError.current = text;
            setError(text);
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 1000 * failures)));
        }
      }
    })();
    return () => controller.abort();
  }, [conn, currentId, loadSessions]);

  // ---------- 模型能不能直接看视频：每个接口地址+模型测一次，看不了的话参考视频改由页面拆成截图和节拍 ----------
  const probeVideo = useCallback(async (target: AiEditConfig) => {
    const key = videoProbeKey(target);
    const attempt = `${key}|${target.apiKey}`;
    if (!conn || probing.has(attempt)) return;
    probing.add(attempt);
    setProbe({ key, running: true });
    // 结果只落到测的那个模型上：测的时候换了模型、切走了页面都不串
    const settle = (next: { key: string; running: boolean; error?: string }) => setProbe((current) => (current.key === key ? next : current));
    try {
      const { videoInput } = await probeAiEditVideo(conn, target);
      // 测的那几十秒里可能切走了页面：直接存进本机，不靠组件还在
      const stored = loadAiEditConfig();
      if (videoProbeKey(stored) === key) saveAiEditConfig({ ...stored, videoInput, videoProbe: key });
      setConfig((current) => (videoProbeKey(current) === key ? { ...current, videoInput, videoProbe: key } : current));
      settle({ key, running: false });
    } catch (reason) {
      settle({ key, running: false, error: errorText(reason, "没测出来，请稍后重试。") });
    } finally {
      probing.delete(attempt);
    }
  }, [conn]);
  // 没测过的接口地址+模型+Key（新填的、改过的、以前存的）自动测一次；测不出来的再测点「重新测」
  useEffect(() => {
    const attempt = `${videoProbeKey(config)}|${config.apiKey}`;
    if (!conn || !config.apiKey.trim() || typeof config.videoInput === "boolean" || probeTried.has(attempt)) return;
    probeTried.add(attempt);
    void probeVideo(config);
  }, [conn, config, probeVideo]);

  // ---------- 采集器请页面帮忙拆视频（截图、节拍），做完交回 ----------
  const lookJob = state?.session.streaming?.look ?? null;
  const lookSessionId = state?.session.id ?? null;
  useEffect(() => {
    if (!lookSessionId) return;
    dropLookJobs(lookSessionId, lookJob?.id ?? null);
    if (!conn || !baseUrl || !mediaKey || !lookJob) return;
    runLookJob(lookSessionId, lookJob, aiEditLookUrl(baseUrl, lookJob.url, mediaKey), (body) => answerAiEditLook(conn, lookSessionId, lookJob.id, body));
  }, [conn, baseUrl, mediaKey, lookJob, lookSessionId]);

  // ---------- 素材库 ----------
  const loadMedia = useCallback(async () => {
    if (!conn) return;
    try {
      const value = await listAiEditMedia(conn);
      setMedia(value.media);
      if (value.key) setMediaKey(value.key);
    } catch (reason) {
      setError(errorText(reason, "素材库没读到，请稍后重试。"));
    }
  }, [conn]);
  useEffect(() => { void loadMedia(); }, [loadMedia]);
  // AI 自己导入素材时会话会变，跟着刷新一下；有导入中的素材就每 2.5 秒看一次
  const sessionRevision = session?.revision ?? 0;
  useEffect(() => {
    if (!sessionRevision) return undefined;
    const timer = setTimeout(() => void loadMedia(), 600);
    return () => clearTimeout(timer);
  }, [sessionRevision, loadMedia]);
  // 本机文件每传完一个刷新素材栏；页面不在时传完的，下次进来那次 loadMedia 会读到
  useEffect(() => uploadQueue.onUploaded(loadMedia), [loadMedia]);
  // 上传失败（包括页面不在时失败的）在这里显示
  useEffect(() => {
    if (!uploads.errors.length) return;
    const failed = uploadQueue.takeErrors();
    if (failed.length) setError(failed.join("\n"));
  }, [uploads.errors]);
  const importing = media.some((item) => item.status === "importing");
  useEffect(() => {
    if (!importing) return undefined;
    const timer = setInterval(() => void loadMedia(), 2500);
    return () => clearInterval(timer);
  }, [importing, loadMedia]);

  // ---------- 剪映草稿箱状态（剪映开没开着），15 秒看一次 ----------
  const loadDraftBox = useCallback(async () => {
    if (!conn) return;
    try { setDraftBox(await getAiEditDraftBox(conn)); } catch { /* 状态行退回默认说明 */ }
  }, [conn]);
  useEffect(() => {
    void loadDraftBox();
    const timer = setInterval(() => void loadDraftBox(), 15_000);
    return () => clearInterval(timer);
  }, [loadDraftBox]);

  // ---------- 动作 ----------
  const createSession = async (canvas?: EditCanvas): Promise<AiEditSessionState | null> => {
    if (!conn) return null;
    setMenuOpen(false);
    try {
      const created = await createAiEditSession(conn, canvas ? { canvas } : {});
      setState(created);
      setSessions((list) => [summaryOf(created.session), ...list.filter((item) => item.id !== created.session.id)]);
      setCurrentId(created.session.id);
      return created;
    } catch (reason) {
      setError(errorText(reason, "没能新建剪辑，请稍后重试。"));
      return null;
    }
  };

  const removeSession = async (id: string) => {
    if (!conn) return;
    try {
      await deleteAiEditSession(conn, id);
      if (id === currentId) setState(null);
      await loadSessions(id === currentId ? null : currentId);
    } catch (reason) {
      setError(errorText(reason, "没删掉，请稍后重试。"));
    }
  };

  const send = async (raw = input) => {
    const text = raw.trim();
    if (!conn || !text || running) return;
    if (!config.apiKey.trim() || !config.model.trim() || !config.baseUrl.trim()) {
      setConfigOpen(true);
      setError("先在 AI 剪辑的接口设置里填好 Key 和模型。");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const target = currentId ? { id: currentId, project } : await createSession().then((created) => created && { id: created.session.id, project: created.project });
      if (!target) return;
      const next = await sendAiEditMessage(conn, target.id, text, config);
      setInput("");
      setState((current) => current?.session.id === next.id ? { ...current, session: next } : target.project ? { session: next, project: target.project } : current);
    } catch (reason) {
      setError(errorText(reason, "消息没发出去，请稍后重试。"));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!conn || !currentId) return;
    try {
      const next = await stopAiEditSession(conn, currentId);
      setState((current) => current && current.session.id === next.id ? { ...current, session: next } : current);
    } catch (reason) {
      setError(errorText(reason, "没停下来，请再点一次。"));
    }
  };

  const exportDraft = async () => {
    if (!conn || !currentId) return;
    // 记下发起导入的剪辑和当时的工程版本：请求回来时用户可能已经切走，提示只记到这个剪辑名下
    const id = currentId;
    const revision = project?.revision ?? null;
    const note = (value: ExportNote) => setExportNotes((notes) => ({ ...notes, [id]: value }));
    setExportingIds((ids) => [...ids, id]);
    setExportNotes((notes) => { const next = { ...notes }; delete next[id]; return next; });
    try {
      const value = await exportAiEditSession(conn, id);
      setState((current) => current && current.session.id === value.session.id ? { ...current, session: value.session } : current);
      setSessions((list) => list.map((item) => item.id === value.session.id ? summaryOf(value.session) : item));
      note({ revision: value.session.draftBox?.exportedRevision ?? revision, tone: "ok", text: value.result.created
        ? `已放进剪映草稿箱，名字是「${value.result.draftName}」，打开剪映就能看到。`
        : `已更新剪映里的「${value.result.draftName}」，重新打开这份草稿就是最新的。` });
    } catch (reason) {
      note({ revision, tone: "warn", text: errorText(reason, "没能导入剪映草稿箱，请稍后重试。") });
    } finally {
      setExportingIds((ids) => ids.filter((item) => item !== id));
      void loadDraftBox();
    }
  };

  const uploadFiles = (files: File[]) => {
    if (conn) void uploadQueue.enqueue(conn, files);
  };

  const removeMedia = async (id: string) => {
    if (!conn) return;
    try { await deleteAiEditMedia(conn, id); await loadMedia(); } catch (reason) { setError(errorText(reason, "没删掉，请稍后重试。")); }
  };

  const addRecord = async (record: PersonalVideoRecord) => {
    if (!conn || !record.url) return;
    await importDouyinMedia(conn, {
      url: record.url, title: record.title || undefined, author: record.author ?? undefined, cover: record.coverUrl ?? undefined,
      videoId: record.videoId ?? undefined, durationSeconds: record.durationSeconds ?? undefined,
    });
    // 等素材库刷新完再算添加成功：重试失败素材时，选择器才不会在刷新前还显示上次的失败
    await loadMedia();
  };

  const mention = (item: AiEditMediaItem) => setInput((text) => `${text}${text && !text.endsWith(" ") ? " " : ""}「${mediaTitle(item)}」`);

  if (!conn) return <View style={[styles.root, styles.gate]}>
    <Scissors size={34} color={color.accent} />
    <Text style={styles.gateTitle}>连接采集器后才能用 AI 剪辑</Text>
    <Text style={kit.body}>素材、对话和时间线都存在采集器里，做好后直接放进剪映草稿箱。</Text>
    <SmallButton label="前往连接" onPress={onOpenSettings} />
  </View>;

  return <View testID="ai-edit-workspace" style={styles.root}>
    <View style={[styles.left, { width: leftWidth }]}>
      <SessionBar
        title={session?.title || (currentId ? "未命名剪辑" : "还没有剪辑")}
        open={menuOpen}
        configOpen={configOpen}
        onToggle={() => setMenuOpen((value) => !value)}
        onCreate={() => void createSession()}
        onToggleConfig={() => setConfigOpen((value) => !value)}
      />
      <View style={styles.middle}>
        {error ? <View accessibilityRole="alert" style={styles.errorBar}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" hitSlop={8} onPress={() => setError(null)} style={webPointer}><X size={13} color={color.danger} /></Pressable>
        </View> : null}
        {configOpen
          ? <ConfigPanel
              config={config}
              probe={probe.key === videoProbeKey(config) ? probe : { key: "", running: false }}
              onRetest={() => void probeVideo(config)}
              onSave={(saved) => {
                // 接口地址和模型没变就沿用测过的结果，变了重测；面板留着显示测的结果
                const next = videoProbeKey(saved) === config.videoProbe ? { ...saved, videoInput: config.videoInput, videoProbe: config.videoProbe } : saved;
                saveAiEditConfig(next);
                setConfig(next);
                setError(null);
              }}
              onCancel={config.apiKey ? () => setConfigOpen(false) : undefined}
            />
          : <Conversation session={session} loaded={sessionsLoaded} onSuggest={(text) => setInput(text)} />}
        {menuOpen ? <SessionMenu sessions={sessions} currentId={currentId} onPick={(id) => { setCurrentId(id); setMenuOpen(false); }} onCreate={(canvas) => void createSession(canvas)} onRemove={(id) => void removeSession(id)} /> : null}
      </View>
      {configOpen ? null : <MediaShelf
        media={media}
        uploads={uploads.tasks}
        mediaUrl={mediaUrl}
        onPick={mention}
        onRemove={(id) => void removeMedia(id)}
        onOpenLibrary={() => setPickerOpen(true)}
        onUpload={uploadFiles}
      />}
      <Composer value={input} onChange={setInput} running={running} sending={sending} onSend={() => void send()} onStop={() => void stop()} />
    </View>

    <Board
      session={session}
      project={project}
      media={media}
      mediaUrl={mediaUrl}
      draftBox={draftBox}
      exporting={exporting}
      exportNote={exportNote}
      running={running}
      onExport={() => void exportDraft()}
    />

    {pickerOpen ? <LibraryPicker records={records} media={media} onAdd={addRecord} onClose={() => setPickerOpen(false)} /> : null}
  </View>;
}

/** 父组件每次渲染都会新建 connection 对象和回调；只在连接或记录真的变了时才重渲染，免得打断预览播放。 */
export const AiEditWorkspace = memo(AiEditWorkspaceImpl, (before, after) =>
  before.connection?.baseUrl === after.connection?.baseUrl && before.connection?.token === after.connection?.token && before.records === after.records);

const sortSessions = (list: AiEditSessionSummary[]) => [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

const summaryOf = ({ id, title, createdAt, updatedAt, status, projectId, draftBox }: AiEditSession): AiEditSessionSummary =>
  ({ id, title, createdAt, updatedAt, status, projectId, draftBox });

const mediaTitle = (item: AiEditMediaItem) => (item.source.type === "douyin" && item.source.title) || item.name.replace(/\.[^.]+$/u, "");

function shortTime(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `今天 ${clock}` : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`;
}

// ============================== 左栏 ==============================

function SessionBar({ title, open, configOpen, onToggle, onCreate, onToggleConfig }: {
  title: string; open: boolean; configOpen: boolean; onToggle: () => void; onCreate: () => void; onToggleConfig: () => void;
}) {
  return <View style={styles.sessionBar}>
    <Pressable accessibilityRole="button" accessibilityLabel="最近的剪辑" accessibilityState={{ expanded: open }} onPress={onToggle} style={[styles.sessionPick, webPointer]}>
      <Text numberOfLines={1} style={styles.sessionTitle}>{title}</Text>
      <ChevronDown size={15} color={color.textMuted} />
    </Pressable>
    <Pressable {...ws("btn square")} accessibilityRole="button" accessibilityLabel="新建剪辑" onPress={onCreate} style={[styles.iconButton, webPointer]}><Plus size={16} color={color.text} /></Pressable>
    <Pressable {...ws("btn square", configOpen && "on")} accessibilityRole="button" accessibilityLabel="接口设置" accessibilityState={{ expanded: configOpen }} onPress={onToggleConfig} style={[styles.iconButton, webPointer]}><Settings2 size={16} color={color.text} /></Pressable>
  </View>;
}

function SessionMenu({ sessions, currentId, onPick, onCreate, onRemove }: {
  sessions: AiEditSessionSummary[]; currentId: string | null; onPick: (id: string) => void; onCreate: (canvas: EditCanvas) => void; onRemove: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return <View {...ws("e-box")} style={styles.menu}>
    <ScrollView style={styles.menuList} contentContainerStyle={{ paddingVertical: 4 }}>
      {sessions.length ? sessions.map((item) => {
        const on = item.id === currentId;
        return <View key={item.id} style={[styles.menuRow, on && styles.menuRowOn]}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onPick(item.id)} style={[styles.menuPick, webPointer]}>
            <Text numberOfLines={1} style={[styles.menuTitle, on && kit.strong]}>{item.title || "未命名剪辑"}</Text>
            <Text style={kit.muted}>{item.status === "running" ? "AI 正在剪" : shortTime(item.updatedAt)}{item.draftBox ? " · 已导入剪映" : ""}</Text>
          </Pressable>
          {confirm === item.id
            ? <View style={kit.row}>
              <Pressable accessibilityRole="button" onPress={() => { setConfirm(null); onRemove(item.id); }} style={webPointer}><Text style={styles.dangerLink}>删除</Text></Pressable>
              <Pressable accessibilityRole="button" onPress={() => setConfirm(null)} style={webPointer}><Text style={kit.muted}>取消</Text></Pressable>
            </View>
            : <Pressable accessibilityRole="button" accessibilityLabel={`删除「${item.title || "未命名剪辑"}」`} hitSlop={6} onPress={() => setConfirm(item.id)} style={webPointer}><Trash2 size={14} color={color.textMuted} /></Pressable>}
        </View>;
      }) : <Text style={[kit.muted, { padding: 12 }]}>还没有剪辑，发第一句话就会新建一个。</Text>}
    </ScrollView>
    <View style={styles.menuFoot}>
      <Text style={kit.muted}>新建</Text>
      {CANVASES.map((item) => <Pressable key={item.label} {...ws("btn small")} accessibilityRole="button" onPress={() => onCreate(item.canvas)} style={[styles.chip, webPointer]}><Text style={styles.chipText}>{item.label}</Text></Pressable>)}
    </View>
    <Text style={[kit.muted, styles.menuNote]}>删除只删这里的对话和时间线，已经放进剪映的草稿不受影响。</Text>
  </View>;
}

function videoInputNote(config: AiEditConfig, probe: { running: boolean; error?: string; key?: string }): string {
  if (probe.running) return "正在测这个模型能不能直接看视频……";
  const known = config.videoInput === true ? "这个模型能直接看视频，参考视频会整段发给它（画面和声音都能用上）。"
    : config.videoInput === false ? "这个模型看不了视频。解析参考视频时，应用会先把视频拆成镜头截图和音乐节拍再交给它，这时要开着应用。"
      : null;
  if (probe.error) return known ? `这次没测出来（${probe.error}），先沿用上次的结果：${known}` : `没测出这个模型能不能直接看视频（${probe.error}）。解析参考视频时会先整段发给它，看不了再拆成截图。`;
  return known ?? "还没测过这个模型能不能直接看视频。";
}

function ConfigPanel({ config, probe, onSave, onRetest, onCancel }: {
  config: AiEditConfig;
  probe: { running: boolean; error?: string; key?: string };
  onSave: (config: AiEditConfig) => void;
  onRetest: () => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(config);
  // 保存后面板留着显示测的结果，按钮上闪一下「已保存」
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);
  const field = (key: "apiKey" | "model" | "baseUrl", label: string, props: Partial<React.ComponentProps<typeof TextInput>> = {}) => <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={draft[key]} onChangeText={(text) => setDraft((current) => ({ ...current, [key]: text }))} placeholderTextColor={color.textMuted} style={styles.fieldInput} {...props} />
  </View>;
  const ready = Boolean(draft.apiKey.trim() && draft.model.trim() && draft.baseUrl.trim());
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.configScroll}>
    <View {...ws("e-box")} style={styles.configBox}>
      <Text style={styles.configTitle}>接口设置</Text>
      <Text style={kit.muted}>AI 剪辑用自己的一套接口，和解析库的设置分开。模型要能调用工具，Key 只存在这台电脑上。</Text>
      {field("apiKey", "API Key", { secureTextEntry: true, placeholder: "从大模型服务商获取 API Key" })}
      {field("model", "模型", { placeholder: "doubao-seed-2-1-lite-260915" })}
      {field("baseUrl", "接口地址", { placeholder: "https://ark.cn-beijing.volces.com/api/v3" })}
      <View style={kit.row}>
        <SmallButton label={saved ? "已保存" : "保存"} disabled={!ready} onPress={() => { onSave({ apiKey: draft.apiKey.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim() }); setSaved(true); }} />
        {onCancel ? <SmallButton label="收起" onPress={onCancel} /> : null}
      </View>
      {config.apiKey ? <View style={styles.probeRow}>
        <Text style={[kit.muted, { flex: 1 }]}>{videoInputNote(config, probe)}</Text>
        {probe.running ? <ActivityIndicator size="small" color={color.cyan} /> : <SmallButton label="重新测" onPress={onRetest} />}
      </View> : null}
    </View>
  </ScrollView>;
}

function Conversation({ session, loaded, onSuggest }: { session: AiEditSession | null; loaded: boolean; onSuggest: (text: string) => void }) {
  const scrollRef = useRef<ScrollView>(null);
  const stick = useRef(true);
  const messages = session?.messages ?? [];
  const streaming = session?.streaming?.text ?? "";
  const liveActions = session?.streaming?.actions ?? [];
  const look = session?.streaming?.look;
  const busy = sessionRunning(session);
  // 新消息、流式文字一长就贴着底部；用户往上翻了就不打扰
  useLayoutEffect(() => {
    if (!stick.current) return;
    const node = (scrollRef.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.();
    if (node && typeof node.scrollHeight === "number") node.scrollTop = node.scrollHeight;
    else scrollRef.current?.scrollToEnd({ animated: false });
  }, [messages.length, streaming.length, liveActions.length, busy, session?.id, session?.error]);
  useEffect(() => { stick.current = true; }, [session?.id]);

  if (!loaded) return <View style={styles.centered}><ActivityIndicator color={color.cyan} /></View>;
  // 两个 ScrollView 用不同的 key：RN-web 的 ScrollView 只在挂载时转发 ref，复用同一个实例时后加的 ref 拿不到节点
  if (!messages.length && !streaming && !busy) return <ScrollView key="intro" style={{ flex: 1 }} contentContainerStyle={styles.intro}>
    <Sparkles size={22} color={color.accent} />
    <Text style={styles.introTitle}>说说想剪成什么样</Text>
    <Text style={kit.body}>先在下面放几段素材（内容库里的视频或本机文件），再告诉 AI 想要的时长、节奏和字幕。右边会跟着出时间线，满意了就放进剪映草稿箱接着精修。</Text>
    {SUGGESTIONS.map((text) => <Pressable key={text} {...ws("btn")} accessibilityRole="button" onPress={() => onSuggest(text)} style={[styles.suggestion, webPointer]}>
      <Text style={styles.suggestionText}>{text}</Text>
    </Pressable>)}
  </ScrollView>;

  return <ScrollView
    key="messages"
    ref={scrollRef}
    style={{ flex: 1 }}
    contentContainerStyle={styles.messages}
    scrollEventThrottle={50}
    onScroll={(event) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 60;
    }}
  >
    {messages.map((item) => <Message key={item.id} item={item} />)}
    {busy ? <View {...ws("c-bubble", "in")} style={[styles.bubble, styles.bubbleIn]}>
      {streaming ? <Markdown compact text={streaming} /> : null}
      {liveActions.length ? <ActionList actions={liveActions} live /> : null}
      <View style={kit.row}><ActivityIndicator size="small" color={color.cyan} /><Text style={kit.muted}>{look ? (look.kind === "beats" ? "正在测配乐的节拍…" : "正在把参考视频拆成镜头截图和节拍，拆完交给 AI 看…") : liveActions.length ? "正在改时间线…" : streaming ? "还在写…" : "AI 正在想…"}</Text></View>
    </View> : null}
    {session?.error ? <View accessibilityRole="alert" style={styles.sessionError}><Text style={styles.errorText}>{session.error.message}</Text></View> : null}
  </ScrollView>;
}

function Message({ item }: { item: AiEditChatItem }) {
  if (item.role === "user") return <View style={styles.ownLine}>
    <View {...ws("c-bubble", "own")} style={[styles.bubble, styles.bubbleOwn]}><Text selectable style={styles.bubbleText}>{item.text}</Text></View>
  </View>;
  return <View {...ws("c-bubble", "in")} style={[styles.bubble, styles.bubbleIn]}>
    {item.text ? <Markdown compact text={item.text} /> : null}
    {item.actions?.length ? <ActionList actions={item.actions} /> : null}
  </View>;
}

/** AI 做过的步骤，小字列出；多了先收起，正在进行的那一轮只看最近几步。 */
function ActionList({ actions, live = false }: { actions: AiEditAction[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? actions : live ? actions.slice(-4) : actions.slice(0, 4);
  const hidden = actions.length - shown.length;
  return <View style={styles.actions}>
    {live && hidden > 0 ? <Text style={styles.actionText}>前面已经做了 {hidden} 步</Text> : null}
    {shown.map((action, index) => <View key={index} style={styles.actionRow}>
      {action.ok ? <Check size={12} color={color.green} /> : <X size={12} color={color.danger} />}
      <Text style={[styles.actionText, !action.ok && { color: color.danger }]}>{action.summary}{!action.ok && action.error ? `：${action.error}` : ""}</Text>
    </View>)}
    {!live && actions.length > 4 ? <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)} style={webPointer}>
      <Text style={styles.linkText}>{expanded ? "收起" : `还有 ${hidden} 步`}</Text>
    </Pressable> : null}
  </View>;
}

function MediaShelf({ media, uploads, mediaUrl, onPick, onRemove, onOpenLibrary, onUpload }: {
  media: AiEditMediaItem[]; uploads: Array<{ key: string; name: string; progress: number }>; mediaUrl: (id: string) => string | null;
  onPick: (item: AiEditMediaItem) => void; onRemove: (id: string) => void; onOpenLibrary: () => void; onUpload: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  return <View style={styles.shelf}>
    <View style={styles.shelfHead}>
      <Text style={styles.shelfTitle}>素材 <Text style={kit.muted}>{media.length ? `${media.length} 个` : ""}</Text></Text>
      <View style={styles.shelfActions}>
        <Pressable {...ws("btn small")} accessibilityRole="button" accessibilityLabel="从内容库添加" onPress={onOpenLibrary} style={[styles.chip, webPointer]}>
          <Library size={13} color={color.text} /><Text style={styles.chipText}>内容库</Text>
        </Pressable>
        <Pressable {...ws("btn small")} accessibilityRole="button" accessibilityLabel="添加本地文件" onPress={() => inputRef.current?.click()} style={[styles.chip, webPointer]}>
          <FolderOpen size={13} color={color.text} /><Text style={styles.chipText}>本地文件</Text>
        </Pressable>
      </View>
      {web ? <input ref={inputRef} type="file" multiple accept="video/*,image/*,audio/*,.mkv,.flac" style={{ display: "none" }}
        onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; onUpload(files); }} /> : null}
    </View>
    {media.length || uploads.length ? <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.shelfRow}>
      {uploads.map((item) => <View key={item.key} style={styles.card}>
        <View style={[styles.thumb, styles.thumbEmpty]}><Text style={styles.thumbProgress}>{Math.round(item.progress * 100)}%</Text></View>
        <Text numberOfLines={1} style={styles.cardName}>{item.name}</Text>
        <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} /></View>
      </View>)}
      {media.map((item) => <View key={item.id} style={styles.card}>
        <Pressable accessibilityRole="button" accessibilityLabel={`在消息里提到「${mediaTitle(item)}」`} disabled={item.status !== "ready"} onPress={() => onPick(item)} style={webPointer}>
          <MediaThumb item={item} url={mediaUrl(item.id)} />
          <Text numberOfLines={1} style={styles.cardName}>{mediaTitle(item)}</Text>
          <Text numberOfLines={1} style={[styles.cardMeta, item.status === "failed" && { color: color.danger }]}>
            {item.status === "importing" ? "正在导入…" : item.status === "failed" ? (item.error || "导入失败") : item.kind === "image" ? "图片" : item.durationUs ? spokenDuration(item.durationUs) : item.kind === "audio" ? "音频" : "视频"}
          </Text>
        </Pressable>
        {confirm === item.id
          ? <View style={styles.cardConfirm}>
            <Pressable accessibilityRole="button" onPress={() => { setConfirm(null); onRemove(item.id); }} style={webPointer}><Text style={styles.dangerLink}>删除</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setConfirm(null)} style={webPointer}><Text style={styles.cardMeta}>取消</Text></Pressable>
          </View>
          : <Pressable accessibilityRole="button" accessibilityLabel={`从素材库删除「${mediaTitle(item)}」`} hitSlop={6} onPress={() => setConfirm(item.id)} style={[styles.cardRemove, webPointer]}>
            <X size={11} color={color.white} />
          </Pressable>}
      </View>)}
    </ScrollView> : <Text style={[kit.muted, styles.shelfEmpty]}>还没有素材：可以从内容库挑抖音视频，也可以选本机的视频、图片和音乐。</Text>}
  </View>;
}

function MediaThumb({ item, url }: { item: AiEditMediaItem; url: string | null }) {
  // 抖音封面地址会过期（403），读失败就记下这个地址，改画本地文件的第一帧或图标
  const [failedCover, setFailedCover] = useState<string | null>(null);
  const view = mediaThumbView(item, Boolean(url), failedCover);
  const cover = view.cover;
  if (view.show === "pending" || !url) return <View style={[styles.thumb, styles.thumbEmpty]}>
    {cover ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailedCover(cover)} /> : null}
    {item.status === "importing" ? <ActivityIndicator size="small" color={color.white} /> : item.kind === "audio" ? <Music2 size={18} color={color.textMuted} /> : <Film size={18} color={color.textMuted} />}
  </View>;
  if (view.show === "audio") return <View style={[styles.thumb, styles.thumbEmpty]}><Music2 size={18} color={color.green} /></View>;
  return <View style={[styles.thumb, styles.thumbEmpty]}>
    {view.show === "image" ? <img src={url} alt="" draggable={false} style={thumbMedia} />
      : cover ? <img src={cover} alt="" draggable={false} referrerPolicy="no-referrer" style={thumbMedia} onError={() => setFailedCover(cover)} />
        // 只读元数据时 Chrome 不一定画出第一帧；读到时长后主动跳到半秒处，让它取一帧画上
        : <video src={url} preload="metadata" muted playsInline style={thumbMedia}
          onLoadedMetadata={(event) => { const video = event.currentTarget; video.currentTime = Math.min(0.5, (video.duration || 1) / 2); }} />}
  </View>;
}

/** 内容库选择器里的封面：地址过期读不出来时退回胶片图标，不留一块空白。 */
function PickCover({ uri }: { uri: string | null | undefined }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <View style={styles.pickCover}>
    {uri && uri !== failed ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(uri)} /> : <Film size={16} color={color.textMuted} />}
  </View>;
}
const thumbMedia: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" };

function Composer({ value, onChange, running, sending, onSend, onStop }: {
  value: string; onChange: (text: string) => void; running: boolean; sending: boolean; onSend: () => void; onStop: () => void;
}) {
  const canSend = Boolean(value.trim()) && !running;
  return <View {...ws("c-composer")} style={styles.composer}>
    <TextInput
      accessibilityLabel="和 AI 说怎么剪"
      multiline
      maxLength={4000}
      value={value}
      onChangeText={onChange}
      onKeyPress={(event) => {
        // 回车发送，Shift+回车换行；输入法选词时的回车不算
        const key = event.nativeEvent as unknown as KeyboardEvent;
        if (key.key !== "Enter" || key.shiftKey || key.isComposing || key.keyCode === 229) return;
        event.preventDefault();
        if (canSend) onSend();
      }}
      placeholder={running ? "AI 正在剪，可以先想下一句" : "说说想怎么剪（回车发送，Shift+回车换行）"}
      placeholderTextColor={color.textMuted}
      {...ws("c-input")}
      style={[styles.input, webAutoHeight]}
    />
    {running && !sending
      ? <Pressable {...ws("c-send", "on")} accessibilityRole="button" accessibilityLabel="停止" onPress={onStop} style={[styles.send, styles.sendReady, webPointer]}>
        <Square size={14} color={color.canvas} fill={color.canvas} />
      </Pressable>
      : <Pressable {...ws("c-send", canSend && "on")} accessibilityRole="button" accessibilityLabel={sending ? "正在发送" : "发送"} accessibilityState={{ disabled: !canSend, busy: sending }} disabled={!canSend} onPress={onSend} style={[styles.send, canSend && styles.sendReady, webPointer]}>
        {sending ? <ActivityIndicator size="small" color={color.textMuted} /> : <Send size={16} color={canSend ? color.canvas : color.textMuted} />}
      </Pressable>}
  </View>;
}

// ============================== 内容库选择器 ==============================

type LibraryRow = { key: string; record: PersonalVideoRecord; source: string };
type LibraryTab = "all" | "liked_videos" | "favorite_videos" | "watch_history";
const SOURCE_LABEL: Record<Exclude<LibraryTab, "all">, string> = { liked_videos: "喜欢", favorite_videos: "收藏", watch_history: "看过" };

function LibraryPicker({ records, media, onAdd, onClose }: {
  records: PersonalRecordCollection; media: AiEditMediaItem[]; onAdd: (record: PersonalVideoRecord) => Promise<void>; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<LibraryTab>("all");
  const [added, setAdded] = useState<Record<string, "busy" | "done" | { error: string }>>({});
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const list: LibraryRow[] = [];
    for (const type of ["liked_videos", "favorite_videos", "watch_history"] as const) {
      if (tab !== "all" && tab !== type) continue;
      for (const record of records[type] ?? []) {
        if (!record.url || record.mediaType === "image" || record.mediaType === "live") continue;
        const key = record.videoId || record.url;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ key, record, source: SOURCE_LABEL[type] });
      }
    }
    return list;
  }, [records, tab]);
  const shown = useMemo(() => {
    if (!query.trim()) return rows;
    const hits = new Set(searchRecords(rows.map((row) => row.record), query));
    return rows.filter((row) => hits.has(row.record));
  }, [rows, query]);
  // 已经在素材库里的（按作品编号或链接认）直接标成已添加；导入失败的留着重试入口，采集器会对失败的那条重新下载
  const inLibrary = useMemo(() => {
    const map = new Map<string, AiEditMediaItem>();
    for (const item of media) {
      for (const key of [item.source.videoId, item.source.url]) {
        if (!key) continue;
        const known = map.get(key);
        if (!known || known.status === "failed") map.set(key, item);
      }
    }
    return map;
  }, [media]);
  const extraData = useMemo(() => ({ added, inLibrary }), [added, inLibrary]);

  const add = async (row: LibraryRow) => {
    setAdded((current) => ({ ...current, [row.key]: "busy" }));
    try {
      await onAdd(row.record);
      setAdded((current) => ({ ...current, [row.key]: "done" }));
    } catch (reason) {
      setAdded((current) => ({ ...current, [row.key]: { error: errorText(reason, "没加进去，请稍后重试。") } }));
    }
  };

  return <View style={styles.overlay}>
    <Pressable accessibilityLabel="关闭内容库" onPress={onClose} style={StyleSheet.absoluteFill} />
    <View {...ws("e-box")} style={styles.picker}>
      <View style={kit.between}>
        <Text style={styles.pickerTitle}>从内容库添加素材</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭" hitSlop={8} onPress={onClose} style={webPointer}><X size={16} color={color.textMuted} /></Pressable>
      </View>
      <TextInput accessibilityLabel="搜索内容库" autoFocus value={query} onChangeText={setQuery} placeholder="搜标题、作者、话题" placeholderTextColor={color.textMuted} style={styles.fieldInput} />
      <View style={kit.between}>
        <Segmented small value={tab} onChange={setTab} options={[{ label: "全部", value: "all" }, { label: "喜欢", value: "liked_videos" }, { label: "收藏", value: "favorite_videos" }, { label: "看过", value: "watch_history" }]} />
        <Text style={kit.muted}>{shown.length.toLocaleString("zh-CN")} 条视频</Text>
      </View>
      {rows.length === 0
        ? <Text style={[kit.body, { paddingVertical: 30, textAlign: "center" }]}>{tab === "all" ? "内容库还是空的，先在「连接与采集」里读取观看历史、喜欢和收藏。" : "这一栏还没有视频。"}</Text>
        : <FlatList
          data={shown}
          keyExtractor={(row) => row.key}
          extraData={extraData}
          initialNumToRender={12}
          windowSize={7}
          style={{ flex: 1 }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<Text style={[kit.muted, { paddingVertical: 24, textAlign: "center" }]}>没找到，换个词试试。</Text>}
          renderItem={({ item: row }) => {
            const local = added[row.key];
            const stored = inLibrary.get(row.record.videoId ?? "") ?? inLibrary.get(row.record.url ?? "");
            const state = local === "busy" ? local
              : stored?.status === "failed" ? (typeof local === "object" ? local : { error: stored.error ? `上次没导入成功：${stored.error}` : "上次没导入成功，可以再试一次。" })
                : stored ? "done" : local;
            const failed = typeof state === "object" ? state.error : null;
            const facts = [row.record.author, row.record.durationSeconds ? spokenDuration(row.record.durationSeconds * US_PER_SECOND) : null, row.source].filter(Boolean).join(" · ");
            return <View style={styles.pickRow}>
              <PickCover uri={row.record.coverUrl} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text numberOfLines={2} style={styles.pickTitle}>{row.record.title || "没有标题的视频"}</Text>
                <Text numberOfLines={1} style={[kit.muted, failed && { color: color.danger }]}>{failed ?? facts}</Text>
              </View>
              {state === "done"
                ? <View style={styles.pickDone}><Check size={13} color={color.green} /><Text style={kit.muted}>已添加</Text></View>
                : <SmallButton label={state === "busy" ? "添加中…" : failed ? "重试" : "添加"} disabled={state === "busy"} onPress={() => void add(row)}><Plus size={13} color={color.text} /></SmallButton>}
            </View>;
          }}
        />}
      <Text style={kit.muted}>添加后采集器会在后台下载视频，下好就能用；图文作品暂时不能当素材。</Text>
    </View>
  </View>;
}

// ============================== 右栏：看板 ==============================

function Board({ session, project, media, mediaUrl, draftBox, exporting, exportNote, running, onExport }: {
  session: AiEditSession | null; project: EditProject | null; media: AiEditMediaItem[]; mediaUrl: (id: string) => string | null;
  draftBox: AiEditDraftBoxStatus | null; exporting: boolean; exportNote: ExportNote | null; running: boolean; onExport: () => void;
}) {
  const duration = projectDuration(project);
  const playback = usePlayback(duration, project?.id ?? null);
  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);

  // 点轨道上的片段：选中、播放头跳到片段开头，旁边弹出只读详情。片段被 AI 删掉或切了剪辑就自动收起
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => findSegment(project, selectedId), [project, selectedId]);
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  const latest = useRef({ project, selectedId });
  latest.current = { project, selectedId };
  const { seek } = playback;
  const closeDetail = useCallback(() => setSelectedId(null), []);
  const pick = useCallback((id: string | null) => {
    const { project: current, selectedId: open } = latest.current;
    if (!id || id === open) { setSelectedId(null); return; }
    const found = findSegment(current, id);
    if (!found) return;
    setSelectedId(id);
    seek(found.segment.timeline.start_us);
  }, [seek]);
  useEffect(() => {
    if (!selectedId || !web) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedId]);
  const detail = useMemo(() => {
    if (!selected) return null;
    const { segment, track } = selected;
    const item = "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
    return { id: segment.id, info: clipDetail(segment, { mediaName: item ? mediaTitle(item) : null, track }), tone: clipTone(segment) };
  }, [selected, mediaById]);
  const [height, setHeight] = useState(0);
  const trackCount = Math.max(1, project?.tracks.length ?? 0);
  // 轨道区按轨道数定高，最多占看板的四成；剩下的都给画面
  const timelineHeight = Math.round(Math.max(96, Math.min(RULER + trackCount * ROW + 12, height ? height * 0.42 : 200)));
  const status = exporting ? { tone: "muted" as const, text: "正在写进剪映草稿箱…" }
    : exportNote ? { tone: exportNote.tone, text: exportNote.text }
      : draftBox?.status === "unavailable" ? { tone: "warn" as const, text: draftBoxReasonText(draftBox.reason) }
        : draftBox?.jianyingRunning ? { tone: "warn" as const, text: "剪映正在运行，导入前先退出剪映。" }
          : session?.draftBox ? { tone: "muted" as const, text: `${shortTime(session.draftBox.exportedAt)}放进过剪映，名字是「${session.draftBox.draftName}」${project && project.revision !== session.draftBox.exportedRevision ? "，之后又改过，再导入会更新同一份草稿" : ""}。` }
            : { tone: "muted" as const, text: "做好后放进剪映草稿箱，在剪映里接着精修、导出。" };

  return <View style={styles.board} onLayout={(event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height)}>
    <View style={styles.boardHead}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={styles.boardTitle}>{project?.name || session?.title || "剪辑看板"}</Text>
        <Text numberOfLines={1} style={kit.muted}>
          {project ? `${project.canvas.width}×${project.canvas.height} · ${project.canvas.fps} 帧 · 时长 ${formatDuration(duration)}` : "还没有时间线"}
        </Text>
      </View>
      <Pressable
        {...ws("btn-solid")}
        accessibilityRole="button"
        accessibilityLabel="导入剪映草稿箱"
        disabled={!project || !duration || running || exporting}
        onPress={onExport}
        style={[styles.exportButton, (!project || !duration || running || exporting) && styles.disabled, webPointer]}
      >
        {exporting ? <ActivityIndicator size="small" color={color.buttonText} /> : <FolderInput size={15} color={color.buttonText} />}
        <Text style={styles.exportText}>导入剪映草稿箱</Text>
      </Pressable>
    </View>
    <Text accessibilityLiveRegion="polite" numberOfLines={2} style={[styles.status, status.tone === "warn" && { color: color.danger }, status.tone === "ok" && { color: color.green }]}>{status.text}</Text>

    <Preview project={project} mediaById={mediaById} mediaUrl={mediaUrl} playback={playback} duration={duration} running={running}
      detail={detail} onCloseDetail={closeDetail} />
    <Timeline project={project} mediaById={mediaById} mediaUrl={mediaUrl} duration={duration} time={playback.time} height={timelineHeight}
      selectedId={selected ? selectedId : null} onSeek={playback.seek} onPick={pick} />
  </View>;
}

// ---------- 播放 ----------

type Playback = { time: number; playing: boolean; toggle: () => void; seek: (us: number) => void };

/** 播放头按墙上时钟走（rAF），视频元素跟着它校准，不反过来。 */
function usePlayback(duration: number, projectId: string | null): Playback {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timeRef = useRef(0);
  timeRef.current = time;
  const anchor = useRef({ origin: 0, at: 0 });
  useEffect(() => { setPlaying(false); setTime(0); }, [projectId]);
  useEffect(() => { if (time > duration) setTime(duration); }, [duration, time]);
  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    anchor.current = { origin: timeRef.current, at: performance.now() };
    const tick = (now: number) => {
      const next = anchor.current.origin + Math.max(0, now - anchor.current.at) * 1000;
      if (next >= duration) { setTime(duration); setPlaying(false); return; }
      setTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);
  const seek = useCallback((us: number) => {
    const next = Math.min(Math.max(0, us), duration);
    anchor.current = { origin: next, at: performance.now() };
    setTime(next);
  }, [duration]);
  const toggle = useCallback(() => {
    if (playing) { setPlaying(false); return; }
    if (duration <= 0) return;
    if (timeRef.current >= duration) { timeRef.current = 0; setTime(0); }
    setPlaying(true);
  }, [playing, duration]);
  return { time, playing, toggle, seek };
}

// ---------- 画面预览 ----------

function Preview({ project, mediaById, mediaUrl, playback, duration, running, detail, onCloseDetail }: {
  project: EditProject | null; mediaById: Map<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null; playback: Playback; duration: number; running: boolean;
  detail: { id: string; info: ClipDetail; tone: string } | null; onCloseDetail: () => void;
}) {
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [rowWidth, setRowWidth] = useState(0);
  const canvas = project?.canvas ?? { width: 1080, height: 1920, fps: 30 };
  const scale = box.width && box.height ? Math.min(box.width / canvas.width, box.height / canvas.height) : 0;
  const stage = { width: Math.floor(canvas.width * scale), height: Math.floor(canvas.height * scale) };
  // 停在结尾时显示最后一帧
  const shownTime = duration > 0 ? Math.min(playback.time, duration - 1) : 0;
  const frame = useMemo(() => activeFrame(project, shownTime), [project, shownTime]);

  // 只挂载当前和下一段的媒体元素：同一个片段从「预加载」变成「正在放」时 key 不变，元素不重建
  const layers = useMemo(() => {
    const list: Array<{ layer: { track: EditTrack; trackIndex: number; segment: EditSegment }; active: boolean }> = [];
    const active = new Set([...frame.visuals, ...frame.audios].map((layer) => layer.segment.id));
    (project?.tracks ?? []).forEach((track, trackIndex) => {
      for (const layer of [...frame.visuals, ...frame.audios]) if (layer.trackIndex === trackIndex) list.push({ layer, active: true });
      const next = nextSegmentAfter(track, shownTime);
      if (next && (next.kind === "video" || next.kind === "audio") && next.timeline.start_us - shownTime < 4 * US_PER_SECOND && !active.has(next.id)) {
        list.push({ layer: { track, trackIndex, segment: next }, active: false });
      }
    });
    return list;
  }, [frame, project, shownTime]);

  const names = useMemo(() => {
    const items: string[] = [];
    for (const { segment } of frame.overlays) items.push(segment.kind === "track_effect" ? `特效 ${featureName(segment.effect_type)}` : segment.kind === "track_filter" ? `滤镜 ${featureName(segment.filter_type)}` : "");
    for (const { segment } of frame.visuals) {
      if ("filters" in segment) for (const item of segment.filters ?? []) items.push(`滤镜 ${featureName(item.filter_type)}`);
      if ("effects" in segment) for (const item of segment.effects ?? []) items.push(`特效 ${featureName(item.effect_type)}`);
      if ("animations" in segment) for (const item of segment.animations ?? []) items.push(`动画 ${featureName(item.animation_type)}`);
    }
    return [...new Set(items.filter(Boolean))];
  }, [frame]);

  return <View style={styles.preview}>
    <View style={styles.previewRow} onLayout={(event: LayoutChangeEvent) => setRowWidth(event.nativeEvent.layout.width)}>
      <View style={styles.stageBox} onLayout={(event: LayoutChangeEvent) => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
        {scale > 0 ? <div aria-label="画面预览" style={{ position: "relative", width: stage.width, height: stage.height, overflow: "hidden", backgroundColor: color.black, isolation: "isolate", borderRadius: 2 }}>
          {layers.map(({ layer, active }) => <Layer key={layer.segment.id} layer={layer} active={active} canvas={canvas} stage={stage}
            time={shownTime} playing={playback.playing} mediaById={mediaById} mediaUrl={mediaUrl} />)}
          {!project || !duration ? <div style={stageNote}>{running ? "AI 正在搭时间线…" : "还没有画面"}</div> : null}
        </div> : null}
      </View>
      {/* 详情卡放在画面右边、不压轨道区；画面跟着让出宽度，内容多时卡片里面滚。
          key 取片段 id：换了片段就从卡片顶上看起，同一片段被 AI 改了内容时滚动位置不动 */}
      {detail ? <ClipCard key={detail.id} detail={detail.info} tone={detail.tone} width={Math.round(Math.min(280, Math.max(196, rowWidth * 0.42)))} onClose={onCloseDetail} /> : null}
    </View>
    <View style={styles.controls}>
      <Pressable {...ws("btn square")} accessibilityRole="button" accessibilityLabel={playback.playing ? "暂停" : "播放"} disabled={!duration} onPress={playback.toggle} style={[styles.playButton, !duration && styles.disabled, webPointer]}>
        {playback.playing ? <Pause size={15} color={color.text} /> : <Play size={15} color={color.text} />}
      </Pressable>
      <Text style={styles.clock}>{formatClock(playback.time)} <Text style={kit.muted}>/ {formatClock(duration)}</Text></Text>
      <Text numberOfLines={1} style={[kit.muted, { flex: 1, minWidth: 0, textAlign: "right" }]}>{names.length ? `此刻生效：${names.join("、")}` : ""}</Text>
    </View>
  </View>;
}

/** 片段的只读详情：只有收起按钮，没有任何能改片段的控件。播放时画面每帧重渲染，卡片不跟着重排。 */
const ClipCard = memo(function ClipCard({ detail, tone, width, onClose }: { detail: ClipDetail; tone: string; width: number; onClose: () => void }) {
  return <View {...ws("e-box", "sticky")} accessibilityLabel="片段详情" style={[styles.detail, { width }]}>
    <View style={styles.detailHead}>
      <View style={[styles.detailDot, { backgroundColor: tone }]} />
      <Text numberOfLines={1} style={styles.detailKind}>{detail.kind}片段</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="收起片段详情" hitSlop={8} onPress={onClose} style={[styles.detailClose, webPointer]}>
        <X size={14} color={color.textMuted} />
      </Pressable>
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.detailBody}>
      <Text selectable style={styles.detailTitle}>{detail.title}</Text>
      {detail.rows.map((row, index) => <View key={index} style={styles.detailRow}>
        <Text style={styles.detailLabel}>{row.label}</Text>
        <View style={styles.detailValueBox}>
          {row.swatch ? <View style={[styles.swatch, { backgroundColor: row.swatch }]} /> : null}
          <Text selectable style={styles.detailValue}>{row.value}</Text>
        </View>
      </View>)}
    </ScrollView>
  </View>;
});

const stageNote: React.CSSProperties = {
  position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 12,
  color: alpha(color.white, 0.55), fontSize: 12, fontFamily: font.body,
};

// 元素自己读到的画面尺寸（按 url 记，同一素材换片段不用再等）。素材库的宽高只按 mp4/mov 的旋转信息转正过，
// 不管照片的 EXIF 方向和其他容器；浏览器给的 videoWidth / naturalWidth 都已经转正，以它为准。
const naturalSizes = new Map<string, Size>();

function useNaturalSize(url: string | null): [Size | null, (width: number, height: number) => void] {
  const [, setSeen] = useState<Size | null>(null);
  const report = useCallback((width: number, height: number) => {
    if (!url || !(width > 0 && height > 0)) return;
    naturalSizes.set(url, { width, height });
    // 每个图层自己记一份，尺寸变了才重渲染；同一素材的另一个图层先读到时这里也能跟上
    setSeen((seen) => seen && seen.width === width && seen.height === height ? seen : { width, height });
  }, [url]);
  return [url ? naturalSizes.get(url) ?? null : null, report];
}

function Layer({ layer, active, canvas, stage, time, playing, mediaById, mediaUrl }: {
  layer: { track: EditTrack; trackIndex: number; segment: EditSegment }; active: boolean; canvas: EditCanvas; stage: Size; time: number; playing: boolean;
  mediaById: Map<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null;
}) {
  const { segment, track } = layer;
  const item = "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
  const url = item?.status === "ready" ? mediaUrl(item.id) : null;
  const [natural, reportSize] = useNaturalSize(segment.kind === "audio" ? null : url);
  const offset = Math.max(0, time - segment.timeline.start_us);
  if (segment.kind === "text") return active ? <TextLayer segment={segment} canvas={canvas} stage={stage} offset={offset} /> : null;
  if (segment.kind === "sticker") {
    if (!active) return null;
    const transform = effectiveTransform(segment, offset);
    const side = Math.min(stage.width, stage.height) * 0.22;
    const rect = layerRect(stage, { width: side, height: side }, transform);
    return <div title="贴纸（导进剪映后能看到）" style={{ position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height, opacity: rect.opacity, transform: cssTransform(rect), border: `1px dashed ${alpha(color.white, 0.6)}`, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: alpha(color.white, 0.75) }}>
      <Sticker size={Math.max(12, side * 0.4)} color={alpha(color.white, 0.75)} />
    </div>;
  }
  if (segment.kind !== "video" && segment.kind !== "image" && segment.kind !== "audio") return null;
  if (segment.kind === "audio") return url ? <MediaElement kind="audio" url={url} segment={segment} track={track} time={time} playing={playing} active={active} style={{ display: "none" }} /> : null;

  const transform = effectiveTransform(segment, offset);
  const fit = segment.fit ?? "contain";
  // 有地址时只信元素读到的尺寸；没读到之前框按画布比例、让浏览器按 fit 自己摆，不拉伸。
  // 素材还没就绪时只画占位框，素材库的宽高够用
  const material = url ? natural : item?.width && item.height ? { width: item.width, height: item.height } : null;
  const box = layerBox(stage, material, fit, segment.keyframes);
  const rect = layerRect(stage, box, transform);
  const mask = maskCss(segment.mask as MaskSpec | null | undefined, { width: rect.width, height: rect.height }, material);
  const style: React.CSSProperties = {
    position: "absolute", left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    objectFit: material || (fit === "stretch" && !hasScaleKeyframes(segment.keyframes)) ? "fill" : fit === "cover" && !hasScaleKeyframes(segment.keyframes) ? "cover" : "contain",
    transform: cssTransform(rect), opacity: active ? rect.opacity : 0,
    filter: colorFilter(segment.keyframes, offset) || undefined,
    mixBlendMode: (blendMode(segment.mix_mode?.mode) ?? undefined) as React.CSSProperties["mixBlendMode"],
    clipPath: cropClipPath(segment.crop) ?? undefined,
    pointerEvents: "none",
    ...(mask as React.CSSProperties | null),
  };
  const fill = active && segment.background_filling ? <div style={{ position: "absolute", inset: 0, backgroundColor: segment.background_filling.fill_type === "color" ? rgba(segment.background_filling.color ?? "#000000") : color.black, overflow: "hidden" }}>
    {segment.background_filling.fill_type === "blur" && segment.kind === "image" && url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", filter: `blur(${Math.round(4 + (segment.background_filling.blur ?? 0.0625) * 60)}px)`, transform: "scale(1.1)" }} /> : null}
  </div> : null;
  if (!url) return active ? <>{fill}<div style={{ ...style, objectFit: undefined, opacity: rect.opacity, backgroundColor: alpha(color.white, 0.08), border: `1px solid ${alpha(color.white, 0.18)}`, display: "flex", alignItems: "center", justifyContent: "center", color: alpha(color.white, 0.6), fontSize: 11, fontFamily: font.body, textAlign: "center", padding: 6, boxSizing: "border-box" }}>
    {item?.status === "importing" ? "素材还在导入" : clipLabel(segment, item ? mediaTitle(item) : null)}
  </div></> : null;
  if (segment.kind === "image") return active ? <>{fill}<img src={url} alt="" draggable={false} style={style}
    onLoad={(event) => reportSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /></> : null;
  return <>{fill}<MediaElement kind="video" url={url} segment={segment} track={track} time={time} playing={playing} active={active} style={style} onSize={reportSize} /></>;
}

function MediaElement({ kind, url, segment, track, time, playing, active, style, onSize }: {
  kind: "video" | "audio"; url: string; segment: EditMediaSegment; track: EditTrack; time: number; playing: boolean; active: boolean; style: React.CSSProperties;
  onSize?: (width: number, height: number) => void;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // 每次渲染都校准：偏差超过 0.15 秒（暂停时 0.03 秒）才 seek，倍速、音量、静音跟着片段走
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!active) {
      if (!element.paused) element.pause();
      const start = segment.source.start_us / US_PER_SECOND;
      if (!element.seeking && Math.abs(element.currentTime - start) > 0.15) element.currentTime = start;
      element.muted = true;
      return;
    }
    const target = sourceTimeUs(segment, time) / US_PER_SECOND;
    const rate = playbackRate(segment.speed);
    if (element.playbackRate !== rate) element.playbackRate = rate;
    (element as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = !segment.change_pitch;
    const sound = mediaVolume(segment, track, time - segment.timeline.start_us);
    element.volume = sound.volume;
    element.muted = sound.muted;
    if (!element.seeking && Math.abs(element.currentTime - target) > (playing ? 0.15 : 0.03)) element.currentTime = target;
    if (playing && element.paused) void element.play().catch(() => undefined);
    if (!playing && !element.paused) element.pause();
  });
  useEffect(() => () => ref.current?.pause(), []);
  return kind === "audio"
    ? <audio ref={ref} src={url} preload="auto" style={style} />
    : <video ref={ref} src={url} preload="auto" playsInline muted style={style}
      onLoadedMetadata={(event) => onSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
      onResize={(event) => onSize?.(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} />;
}

function TextLayer({ segment, canvas, stage, offset }: { segment: EditTextSegment; canvas: EditCanvas; stage: Size; offset: number }) {
  const transform = effectiveTransform(segment, offset);
  const css = textCss(segment, canvas, stage) as React.CSSProperties;
  const flipX = transform.flip_horizontal ? -1 : 1;
  const flipY = transform.flip_vertical ? -1 : 1;
  return <div style={{
    position: "absolute",
    left: stage.width / 2 + transform.transform_x * stage.width / 2,
    top: stage.height / 2 - transform.transform_y * stage.height / 2,
    width: "max-content",
    transform: `translate(-50%,-50%) rotate(${transform.rotation}deg) scale(${transform.scale_x * flipX},${transform.scale_y * flipY})`,
    opacity: Math.min(1, Math.max(0, transform.alpha)),
    fontFamily: font.body,
    pointerEvents: "none",
    ...css,
  }}>{segment.text}</div>;
}

// ---------- 轨道区 ----------

const RULER = 22;
const ROW = 28;
const HEAD = 92;

const TRACK_ICON: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  video: Film, audio: Music2, text: Type, sticker: Sticker, effect: Sparkles, filter: SlidersHorizontal,
};

function clipTone(segment: EditSegment): string {
  switch (segment.kind) {
    case "video": case "image": return color.cyan;
    case "audio": return color.green;
    case "text": return color.amber;
    case "sticker": case "track_effect": return color.accent;
    default: return color.figure;
  }
}

function Timeline({ project, mediaById, mediaUrl, duration, time, height, selectedId, onSeek, onPick }: {
  project: EditProject | null; mediaById: Map<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null; duration: number; time: number; height: number;
  selectedId: string | null; onSeek: (us: number) => void; onPick: (id: string | null) => void;
}) {
  const [laneWidth, setLaneWidth] = useState(0);
  const laneRef = useRef<View>(null);
  const areaRef = useRef<View>(null);
  const tracks = project?.tracks ?? [];
  const ticks = useMemo(() => rulerTicks(duration, laneWidth), [duration, laneWidth]);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // 拖轨道区只挪播放头；单击片段是选中它看详情，单击空白处收起详情。片段本身不能动
  useEffect(() => {
    const area = areaRef.current as unknown as HTMLElement | null;
    if (!web || !area?.addEventListener) return undefined;
    const at = (event: PointerEvent) => {
      const lane = laneRef.current as unknown as HTMLElement | null;
      const rect = lane?.getBoundingClientRect();
      return rect ? timeAtX(event.clientX - rect.left, rect.width, duration) : null;
    };
    const down = (event: PointerEvent) => {
      const lane = (laneRef.current as unknown as HTMLElement | null)?.getBoundingClientRect();
      if (!lane || event.button !== 0 || event.clientX < lane.left || duration <= 0) return;
      const clip = (event.target as Element | null)?.closest?.("[data-clip]")?.getAttribute("data-clip") ?? null;
      const startX = event.clientX;
      let dragged = false;
      // 按在空白处立刻挪播放头；按在片段上先不动，松手前没拖开才算点了这个片段
      if (!clip) {
        const first = at(event);
        if (first !== null) onSeek(first);
      }
      const move = (next: PointerEvent) => {
        if (!dragged && Math.abs(next.clientX - startX) < 4) return;
        dragged = true;
        const value = at(next);
        if (value !== null) onSeek(value);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!dragged) pickRef.current(clip);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    area.addEventListener("pointerdown", down);
    return () => area.removeEventListener("pointerdown", down);
  }, [duration, onSeek]);

  const playheadX = duration > 0 && laneWidth > 0 ? (Math.min(time, duration) / duration) * laneWidth : 0;

  return <View {...ws("e-box")} ref={areaRef} style={[styles.timeline, { height }]}>
    <View style={styles.rulerRow}>
      <View style={styles.rulerCorner}><Text style={styles.rulerCornerText}>{tracks.length ? `${tracks.length} 条轨道` : ""}</Text></View>
      <View ref={laneRef} style={[styles.rulerLane, webPointer]} onLayout={(event: LayoutChangeEvent) => setLaneWidth(event.nativeEvent.layout.width)}>
        {ticks.map((tick) => <View key={tick.us} pointerEvents="none" style={[styles.tick, { left: tick.x }]}>
          <Text numberOfLines={1} style={styles.tickText}>{tick.label}</Text>
        </View>)}
        {duration > 0 ? (project?.markers ?? []).map((marker) => <div key={marker.time_us} title={marker.label} style={{
          position: "absolute", left: (marker.time_us / duration) * laneWidth - 4, bottom: 0, width: 0, height: 0,
          borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderTop: `6px solid ${color.accent}`,
        }} />) : null}
      </View>
    </View>
    {tracks.length ? <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
      {tracks.map((track) => <TrackRow key={track.id} track={track} duration={duration} width={laneWidth} mediaById={mediaById} mediaUrl={mediaUrl}
        selectedId={selectedId && track.segments.some((segment) => segment.id === selectedId) ? selectedId : null} onPick={onPick} />)}
    </ScrollView> : <View style={styles.timelineEmpty}><Text style={kit.muted}>时间线还是空的，AI 加了片段会出现在这里。</Text></View>}
    {duration > 0 && laneWidth > 0 ? <View pointerEvents="none" style={[styles.playhead, { left: HEAD + playheadX }]} /> : null}
  </View>;
}

const TrackRow = memo(function TrackRow({ track, duration, width, mediaById, mediaUrl, selectedId, onPick }: {
  track: EditTrack; duration: number; width: number; mediaById: Map<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null;
  selectedId: string | null; onPick: (id: string | null) => void;
}) {
  const Icon = TRACK_ICON[track.track_type] ?? Film;
  const label = trackLabel(track);
  return <View style={styles.row}>
    <View style={styles.rowHead}>
      <Icon size={12} color={color.textMuted} />
      <Text numberOfLines={1} style={styles.rowName}>{label}</Text>
      {track.mute ? <Text style={styles.rowMute}>静音</Text> : null}
    </View>
    <View style={styles.lane}>
      {width > 0 ? track.segments.map((segment) => <Clip key={segment.id} segment={segment} duration={duration} width={width} mediaById={mediaById} mediaUrl={mediaUrl}
        reach={"transition" in segment && segment.transition ? transitionReach(track.segments, segment) : "next"} selected={segment.id === selectedId} onPick={onPick} />) : null}
    </View>
  </View>;
});

/** 视频片段里按时间均匀取的几帧：排进全页的取帧队列，卸载（切剪辑、片段没了）时撤掉还没取的。 */
function useFilmstrip(mediaId: string | null, url: string | null, times: number[]): Array<string | null> {
  const signature = times.join(",");
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!web || !mediaId || !url || !signature) return undefined;
    const controller = new AbortController();
    for (const time of signature.split(",").map(Number)) {
      if (frameQueue.peek(mediaId, time)) continue;
      void frameQueue.request(mediaId, url, time, controller.signal).then((frame) => {
        if (frame && !controller.signal.aborted) setLoaded((current) => ({ ...current, [`${mediaId}@${time}`]: frame }));
      });
    }
    return () => controller.abort();
  }, [mediaId, url, signature]);
  return times.map((time) => (mediaId ? loaded[`${mediaId}@${time}`] ?? frameQueue.peek(mediaId, time) ?? null : null));
}

function Clip({ segment, duration, width, mediaById, mediaUrl, reach, selected, onPick }: {
  segment: EditSegment; duration: number; width: number; mediaById: Map<string, AiEditMediaItem>; mediaUrl: (id: string) => string | null;
  /** 转场能不能接到下一段：轨道最后一段或后面隔着空当时不画转场菱形 */
  reach: TransitionReach; selected: boolean; onPick: (id: string | null) => void;
}) {
  const position = clipPosition(segment.timeline, duration, width);
  const tone = clipTone(segment);
  const item = "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
  const label = clipLabel(segment, item ? mediaTitle(item) : null);
  const extras = clipExtras(segment, reach);
  const span = segment.timeline.duration_us;
  const fade = "fade" in segment ? segment.fade : null;
  const transition = "transition" in segment ? segment.transition : null;
  const title = [label, `${formatClock(segment.timeline.start_us)} 起，${spokenDuration(span)}`, ...extras, "点一下看详情"].join("\n");
  // 画面：视频取几帧缩略图，图片平铺；取不到就留现在的纯色块
  const pictureUrl = web && item?.status === "ready" && (segment.kind === "video" || segment.kind === "image") ? mediaUrl(item.id) : null;
  const count = segment.kind === "video" && pictureUrl ? filmstripCount(position.width) : 0;
  const source = segment.kind === "video" ? segment.source : null;
  const times = useMemo(() => (source ? filmstripTimes(source, count) : []), [source, count]);
  const frames = useFilmstrip(count ? item?.id ?? null : null, count ? pictureUrl : null, times);
  const tiled = segment.kind === "image" && pictureUrl;
  const pictured = Boolean(tiled) || frames.some(Boolean);
  return <div
    data-clip={segment.id}
    role="button"
    tabIndex={0}
    aria-pressed={selected}
    aria-label={`${label}，${secondMark(segment.timeline.start_us)}开始，点一下看详情`}
    title={title}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onPick(segment.id);
    }}
    style={{
      position: "absolute", left: position.left, width: position.width, top: 3, bottom: 3, boxSizing: "border-box", overflow: "hidden", cursor: "pointer",
      borderRadius: 4, border: selected ? `2px solid ${color.text}` : `1px solid ${alpha(tone, 0.6)}`, backgroundColor: alpha(tone, selected ? 0.3 : 0.16),
      outline: selected ? `2px solid ${color.accent}` : undefined, outlineOffset: 1,
      display: "flex", alignItems: "center", paddingLeft: 5, paddingRight: 5, zIndex: selected ? 1 : undefined,
    }}
  >
    {tiled ? <span aria-hidden style={{ ...clipPicture, backgroundImage: `url(${JSON.stringify(pictureUrl)})`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x", backgroundPosition: "left center" }} /> : null}
    {count ? <span aria-hidden style={{ ...clipPicture, display: "flex" }}>
      {frames.map((frame, index) => <span key={index} style={{
        flex: 1, minWidth: 0, backgroundImage: frame ? `url(${JSON.stringify(frame)})` : undefined, backgroundSize: "cover", backgroundPosition: "center",
        borderLeft: index && frame ? `1px solid ${alpha(color.black, 0.35)}` : undefined,
      }} />)}
    </span> : null}
    {position.width > 18 ? <span style={{
      position: "relative", maxWidth: "100%", boxSizing: "border-box", fontSize: 10.5, lineHeight: "14px", color: color.text, fontFamily: font.body, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      // 有画面时名字收成一个小标签，给缩略图多留点地方；设置项数在详情卡里看
      ...(pictured ? { maxWidth: "70%", backgroundColor: alpha(color.surface, 0.82), borderRadius: 3, paddingLeft: 4, paddingRight: 4 } : null),
    }}>
      {label}{extras.length && position.width > 90 && !pictured ? <span style={{ color: color.textMuted }}> · {extras.length} 项设置</span> : null}
    </span> : null}
    {fade?.in_duration_us ? <span style={{ position: "absolute", left: 0, top: 0, height: 2, width: `${(fade.in_duration_us / span) * 100}%`, backgroundColor: tone }} /> : null}
    {fade?.out_duration_us ? <span style={{ position: "absolute", right: 0, top: 0, height: 2, width: `${(fade.out_duration_us / span) * 100}%`, backgroundColor: tone }} /> : null}
    {(segment.keyframes ?? []).map((keyframe, index) => <span key={index} style={{
      position: "absolute", bottom: 1, left: `calc(${(keyframe.offset_us / span) * 100}% - 2px)`, width: 4, height: 4, transform: "rotate(45deg)", backgroundColor: color.text, opacity: 0.7,
    }} />)}
    {transition && reach === "next" ? <span title={`转场 ${featureName(transition.transition_type)}`} style={{
      position: "absolute", right: 1, top: "50%", width: 7, height: 7, marginTop: -3.5, transform: "rotate(45deg)", backgroundColor: color.text, border: `1px solid ${color.surface}`,
    }} /> : null}
    {/* 选中：文字色边框里再描一圈底色、外面再套一圈强调色，盖在缩略图上面，哪种风格、什么画面都认得出来。
        内圈用边框不用 box-shadow：海报风格把 box-shadow 全清掉了 */}
    {selected ? <span aria-hidden style={{ ...clipPicture, boxSizing: "border-box", borderRadius: 2, border: `2px solid ${color.surface}` }} /> : null}
  </div>;
}

const clipPicture: React.CSSProperties = { position: "absolute", inset: 0, pointerEvents: "none" };

// ============================== 样式 ==============================

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, flexDirection: "row", overflow: "hidden" },
  gate: { flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 40 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },

  left: { minHeight: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.border },
  sessionBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  sessionPick: { flex: 1, minWidth: 0, minHeight: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: radius.small },
  sessionTitle: { flexShrink: 1, color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
  iconButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  middle: { flex: 1, minHeight: 0, position: "relative" },
  errorBar: { flexDirection: "row", alignItems: "flex-start", gap: 8, margin: 10, marginBottom: 0, padding: 10, borderRadius: radius.small, backgroundColor: color.dangerSoft },
  errorText: { flex: 1, color: color.danger, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },

  menu: { position: "absolute", top: 0, left: 10, right: 10, maxHeight: "92%", zIndex: 5, gap: 8, padding: 8, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  menuList: { flexGrow: 0, maxHeight: 260 },
  menuRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderRadius: radius.small },
  menuRowOn: { backgroundColor: color.surfaceRaised },
  menuPick: { flex: 1, minWidth: 0, gap: 1 },
  menuTitle: { color: color.text, fontFamily: font.body, fontSize: 13 },
  menuFoot: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", paddingTop: 8, paddingHorizontal: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  menuNote: { paddingHorizontal: 4 },
  dangerLink: { color: color.danger, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  linkText: { color: color.accentAction, fontFamily: font.body, fontSize: 11 },

  configScroll: { padding: 12 },
  configBox: { gap: 10, padding: 14, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  probeRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: color.borderSoft },
  configTitle: { color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
  field: { gap: 5 },
  label: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 },
  fieldInput: { minHeight: 34, paddingHorizontal: 11, color: color.text, fontFamily: font.body, fontSize: 13, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surfaceRaised },

  intro: { gap: 10, padding: 18 },
  introTitle: { color: color.text, fontFamily: font.body, fontSize: 15, fontWeight: "600" },
  suggestion: { paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  suggestionText: { color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  messages: { gap: 10, padding: 12 },
  ownLine: { alignItems: "flex-end" },
  bubble: { gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.medium },
  bubbleOwn: { maxWidth: "88%", borderTopRightRadius: 4, backgroundColor: color.cyanSoft },
  bubbleIn: { alignSelf: "stretch", borderTopLeftRadius: 4, backgroundColor: color.surfaceRaised },
  bubbleText: { color: color.text, fontFamily: font.body, fontSize: 12.5, lineHeight: 20 },
  actions: { gap: 3, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  actionRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  actionText: { flex: 1, color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 16 },
  sessionError: { padding: 10, borderRadius: radius.small, backgroundColor: color.dangerSoft },

  shelf: { gap: 6, paddingTop: 8, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  shelfHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  shelfTitle: { flex: 1, color: color.text, fontFamily: font.body, fontSize: 12, fontWeight: "600" },
  shelfActions: { flexDirection: "row", gap: 6 },
  shelfRow: { gap: 8, paddingHorizontal: 12, paddingBottom: 2 },
  shelfEmpty: { paddingHorizontal: 12, paddingVertical: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  chipText: { color: color.text, fontFamily: font.body, fontSize: 11, fontWeight: "600" },
  card: { width: 78, gap: 2, position: "relative" },
  thumb: { width: 78, height: 48, overflow: "hidden", borderRadius: radius.small, position: "relative" },
  thumbEmpty: { alignItems: "center", justifyContent: "center", backgroundColor: color.surfaceMuted },
  thumbProgress: { color: color.textSecondary, fontFamily: font.mono, fontSize: 11 },
  cardName: { color: color.text, fontFamily: font.body, fontSize: 10.5, lineHeight: 14 },
  cardMeta: { color: color.textMuted, fontFamily: font.body, fontSize: 10, lineHeight: 13 },
  cardRemove: { position: "absolute", top: 3, right: 3, width: 16, height: 16, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: alpha(color.black, 0.55) },
  cardConfirm: { position: "absolute", top: 0, left: 0, right: 0, height: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, borderRadius: radius.small, backgroundColor: alpha(color.surface, 0.94) },
  progressTrack: { height: 3, borderRadius: 2, overflow: "hidden", backgroundColor: color.surfaceMuted },
  progressFill: { height: 3, backgroundColor: color.accentAction },

  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  input: { flex: 1, minWidth: 0, minHeight: 36, maxHeight: 120, paddingHorizontal: 11, paddingVertical: 8, color: color.text, fontFamily: font.body, fontSize: 12.5, lineHeight: 19, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  send: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.medium, backgroundColor: color.surfaceMuted },
  sendReady: { backgroundColor: color.accent },

  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: color.scrim },
  picker: { width: "100%", maxWidth: 620, height: "92%", gap: 10, padding: 16, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  pickerTitle: { color: color.text, fontFamily: font.body, fontSize: 15, fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: color.borderSoft },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  pickCover: { width: 40, height: 54, overflow: "hidden", alignItems: "center", justifyContent: "center", borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  pickTitle: { color: color.text, fontFamily: font.body, fontSize: 12.5, lineHeight: 18 },
  pickDone: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6 },

  board: { flex: 1, minWidth: 0, minHeight: 0, gap: 8, padding: 14 },
  boardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  boardTitle: { color: color.text, fontFamily: font.body, fontSize: 15, fontWeight: "600" },
  status: { marginTop: -4, color: color.textMuted, fontFamily: font.body, fontSize: 11.5, lineHeight: 17 },
  exportButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 13, height: 34, borderRadius: radius.small, backgroundColor: color.button },
  exportText: { color: color.buttonText, fontFamily: font.body, fontSize: 12.5, fontWeight: "600" },
  disabled: { opacity: 0.45 },

  preview: { flex: 1, minHeight: 120, gap: 6 },
  previewRow: { flex: 1, minHeight: 0, flexDirection: "row", gap: 10 },
  stageBox: { flex: 1, minWidth: 0, minHeight: 0, alignItems: "center", justifyContent: "center" },
  detail: { minHeight: 0, overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  detailHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 12, paddingRight: 8, height: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft },
  detailDot: { width: 8, height: 8, borderRadius: 2 },
  detailKind: { flex: 1, minWidth: 0, color: color.textSecondary, fontFamily: font.body, fontSize: 11.5, fontWeight: "600" },
  detailClose: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  detailBody: { gap: 7, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  detailTitle: { marginBottom: 2, color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  detailRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  detailLabel: { width: 52, flexShrink: 0, color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 17 },
  detailValueBox: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: 6 },
  detailValue: { flex: 1, minWidth: 0, color: color.text, fontFamily: font.body, fontSize: 11.5, lineHeight: 17 },
  swatch: { width: 11, height: 11, marginTop: 3, borderRadius: 2, borderWidth: 1, borderColor: color.border },
  controls: { flexDirection: "row", alignItems: "center", gap: 10, height: 30 },
  playButton: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  clock: { color: color.text, fontFamily: font.mono, fontSize: 12, fontVariant: ["tabular-nums"] },

  timeline: { position: "relative", overflow: "hidden", userSelect: "none", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.surface },
  rulerRow: { flexDirection: "row", height: RULER, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  rulerCorner: { width: HEAD, justifyContent: "center", paddingLeft: 8, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.border },
  rulerCornerText: { color: color.textMuted, fontFamily: font.body, fontSize: 10 },
  rulerLane: { flex: 1, position: "relative" },
  tick: { position: "absolute", top: 0, bottom: 0, paddingLeft: 3, borderLeftWidth: 1, borderLeftColor: color.borderSoft, justifyContent: "center" },
  tickText: { color: color.textMuted, fontFamily: font.mono, fontSize: 9.5 },
  timelineEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 10 },
  row: { flexDirection: "row", height: ROW, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft },
  rowHead: { width: HEAD, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.border },
  rowName: { flexShrink: 1, color: color.textSecondary, fontFamily: font.body, fontSize: 11 },
  rowMute: { color: color.textMuted, fontFamily: font.body, fontSize: 9.5 },
  lane: { flex: 1, position: "relative" },
  playhead: { position: "absolute", top: 0, bottom: 0, width: 1.5, marginLeft: -0.75, backgroundColor: color.danger },
});
