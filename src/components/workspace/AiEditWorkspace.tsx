import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Check, ChevronDown, Clock, Film, FolderOpen, ImageIcon, ImagePlus, Library, Music2, Plus, Scissors, Send, Settings2, Sparkles, Square, SquareDashed, Target, Trash2, X } from "lucide-react-native";
import type { PersonalRecordCollection, PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreConnection } from "../../services/explorer";
import {
  aiConfigReady, aiEditLookUrl, aiEditMediaUrl, aiRuntimeOf, answerAiEditLook, isLocalAiRuntime, createAiEditSession, deleteAiEditMedia, deleteAiEditSession, exportAiEditSession, getAiEditDraftBox, getAiEditSession,
  importDouyinMedia, listAiEditMedia, listAiEditSessions, loadAiEditConfig, probeAiEditVideo, revertAiEdit, saveAiEditConfig, sendAiEditMessage, sessionRunning,
  setAiEditGoal, stopAiEditSession, uploadAiEditMedia, videoProbeKey, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_REFS,
  type AiEditAction, type AiEditChatItem, type AiEditConfig, type AiEditDraftBoxStatus, type AiEditExportMode, type AiEditMediaItem,
  type AiEditSession, type AiEditSessionState, type AiEditSessionSummary, type EditCanvas, type EditSegment,
} from "../../services/aiEdit";
import { searchRecords } from "../../services/recordSearch";
import { mediaIdFromPath, mediaThumbView, spokenDuration, US_PER_SECOND, visibleExportNote, type ExportNote } from "./aiEditModel";
import { clipCallName, regionCaption, regionHint } from "./aiEditBoardEdit";
import { IN_FLIGHT_REASON } from "./aiEditInspect";
import type { BoardJump, EditOutcome, EditPerformer } from "./aiEditBoardContext";
import {
  adoptDraft, attachmentRequests, attachmentsPending, clearSent, dropMedia, imagePreview, isImageFile, pasteIsRichText, pastedName, patchAttachment, planAttachments, type AttachDraft,
} from "./aiEditAttach";
import {
  addRefs, composerRefLabel, hideOpenRef, plainReplyRefs, refKey, refRequest, refsCaption, replyRefLabel, sendableRefs, splitReplyRefs, type ComposerRef,
} from "./aiEditRefs";
import { Board } from "./AiEditBoard";
import { areaProps, CANVASES, Expand, errorText, mediaTitle, shortTime, webAutoHeight, webPointer, web, type BoardRegion } from "./aiEditShared";
import { AiRuntimeField, RUNTIME_LABELS, runtimeProblem } from "./AiRuntimeField";
import { dropLookJobs, runLookJob } from "./aiEditLook";
import { createUploadQueue } from "./aiEditUploads";
import { kit, Segmented, SmallButton } from "./CreatorKit";
import { Markdown, type InlineRender } from "./markdownView";
import { ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 剪辑：左边和 AI 对话（会话、素材库、输入框），右边是剪辑看板（AiEditBoard：画面预览 + 轨道）。看板上也能手动挪、裁、切、删片段，
// 改文字和位置大小，在画面上框一块让 AI 只改那里；片段、某一刻、素材能引用到对话里，图能贴进对话框给 AI 看；
// AI 回复里提到的片段和时间点一下看板就跳过去。每一步都能撤销，也能退回到某句话之前。
// 会话、工程、素材都在采集器里（collector/aiEdit/），页面发请求、看结果；切走再回来按采集器的状态恢复。

type Props = { connection: ExploreConnection | null; records: PersonalRecordCollection; onOpenSettings: () => void };

const LAST_SESSION_KEY = "dy2.aiEditSession";
// 上传不随页面卸载中断：切到别的侧栏再回来，进度和失败提示都接得上
// 测模型能不能看视频：整个页面共用，切走再回来不重复测（probing 正在测的、probeTried 自动测过的「地址|模型|Key」）
const probing = new Set<string>();
const probeTried = new Set<string>();
// 对话框里附的图、拖进对话的文件也走这个队列：按 File 认出是哪一个，进度和传好的素材 id 交回输入框上方那一条
type UploadWatch = { progress: (ratio: number) => void; done: (item: AiEditMediaItem) => void; fail: () => void };
const uploadWatch = new Map<File, UploadWatch>();
const uploadQueue = createUploadQueue((connection: ExploreConnection, file: File, onProgress: (ratio: number) => void) => {
  const watch = uploadWatch.get(file);
  uploadWatch.delete(file);
  return uploadAiEditMedia(connection, file, (ratio) => { onProgress(ratio); watch?.progress(ratio); })
    .then((item) => { watch?.done(item); return item; }, (reason: unknown) => { watch?.fail(); throw reason; });
}, (reason) => errorText(reason, "没传上去，请稍后重试。"));
let attachSequence = 0;

/** 输入框上方攒着、随下一句话发出去的：引用的东西和附的文件。记在发起的那个剪辑名下（还没有剪辑时是 null） */
type ComposerDraft = { sessionId: string | null; refs: ComposerRef[]; files: AttachDraft[] };
const emptyDraft = (sessionId: string | null): ComposerDraft => ({ sessionId, refs: [], files: [] });
const NO_REFS: ComposerRef[] = [];
const NO_FILES: AttachDraft[] = [];

function readLastSession(): string | null {
  try { return globalThis.localStorage?.getItem(LAST_SESSION_KEY) ?? null; } catch { return null; }
}
function rememberSession(id: string | null) {
  try {
    if (id) globalThis.localStorage?.setItem(LAST_SESSION_KEY, id);
    else globalThis.localStorage?.removeItem(LAST_SESSION_KEY);
  } catch { /* 记不住就下次进来选最近的 */ }
}

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
  // 左边面板两页：和 AI 说话、看素材（剪辑软件左上角的素材区）
  const [leftTab, setLeftTab] = useState<"chat" | "media">("chat");

  const [sessions, setSessions] = useState<AiEditSessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [state, setState] = useState<AiEditSessionState | null>(null);
  const [media, setMedia] = useState<AiEditMediaItem[]>([]);
  const [mediaKey, setMediaKey] = useState("");
  const uploads = useSyncExternalStore(uploadQueue.subscribe, uploadQueue.getSnapshot);
  const [config, setConfig] = useState<AiEditConfig>(loadAiEditConfig);
  const [configOpen, setConfigOpen] = useState(() => !aiConfigReady(loadAiEditConfig()));
  const configOpenRef = useRef(configOpen);
  configOpenRef.current = configOpen;
  // 测模型能不能直接看视频：key 是测的哪个接口地址+模型，running 时在测，error 是没测出来的原因
  const [probe, setProbe] = useState<{ key: string; running: boolean; error?: string }>({ key: "", running: false });
  const [draftBox, setDraftBox] = useState<AiEditDraftBoxStatus | null>(null);
  // 导入状态按会话记：导入途中切到别的剪辑，那边的按钮和状态行不受影响，结果也只回到发起导入的那个剪辑
  const [exportingIds, setExportingIds] = useState<string[]>([]);
  const [exportNotes, setExportNotes] = useState<Record<string, ExportNote>>({});
  // 导入时发现草稿在剪映里被打开或改过：按剪辑记下那句说明，等用户选另存还是覆盖
  const [exportConflicts, setExportConflicts] = useState<Record<string, string>>({});
  // 手动改动、撤销、退回、换画面比例一次只发一个
  const [editBusy, setEditBusy] = useState(false);
  const editLock = useRef(false);
  // 当前工程的版本：看板先 flush 微调再导入时，请求刚回来、还没重渲染，导入提示要记在新版本名下（perform 回来就更新）
  const revisionNow = useRef<number | null>(null);
  // 画面上框的一块，记在发起框选的剪辑名下；发出去或清掉就没了
  const [regionDraft, setRegionDraft] = useState<{ sessionId: string; region: BoardRegion } | null>(null);
  const [draft, setDraft] = useState<ComposerDraft>(() => emptyDraft(null));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 点了回复里的片段、时间：交给看板跳过去
  const [jump, setJump] = useState<BoardJump | null>(null);
  const [dropping, setDropping] = useState(false);
  const sideRef = useRef<View>(null);
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
  const exportConflict = currentId ? exportConflicts[currentId] ?? null : null;
  const region = regionDraft?.sessionId === currentId ? regionDraft.region : null;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const shownDraft = draft.sessionId === currentId ? draft : null;
  const shownRefs = shownDraft?.refs ?? NO_REFS;
  const shownFiles = shownDraft?.files ?? NO_FILES;
  // 附的图、拖进来的文件没传完（或预览没画好）先不发
  const uploading = attachmentsPending(shownFiles);
  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);
  // 能在看板上手动改：有工程、AI 没在剪、没在导入、上一个手动改动已经回来
  const notEditableReason = !project ? "还没有时间线" : running ? "AI 正在剪，等它做完再改" : exporting ? "正在导入剪映，等导完再改" : editBusy ? IN_FLIGHT_REASON : null;
  const editable = !notEditableReason;
  revisionNow.current = project?.revision ?? null;

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
  // 没测过的接口地址+模型+Key（新填的、改过的、以前存的）自动测一次；测不出来的再测点「重新测」。
  // 本机的 Codex / Claude Code 不用测（都看不了视频），也别拿以前存的 Key 去打接口
  useEffect(() => {
    const attempt = `${videoProbeKey(config)}|${config.apiKey}`;
    if (!conn || isLocalAiRuntime(config.runtime) || !config.apiKey.trim() || typeof config.videoInput === "boolean" || probeTried.has(attempt)) return;
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
      // 还没有剪辑时攒在输入框上方的引用和附图，跟着进这个新剪辑
      if (!currentIdRef.current) setDraft((current) => adoptDraft(current, created.session.id));
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
    if (!conn || !text || running || editLock.current || uploading) return;
    // 发的是此刻看得到的引用和附图；发出去之后才加的留着
    const outgoing = shownDraft;
    if (!aiConfigReady(config)) {
      setConfigOpen(true);
      setError("先在 AI 设置里填好 Key 和模型。");
      return;
    }
    // 先标成正在发：下面要等一次检测，这期间再按发送会被挡住
    setSending(true);
    setError(null);
    try {
      // 已经查出本机的 Codex / Claude Code 用不了（没登录之类）：先说清楚，不白跑一轮
      const problem = await runtimeProblem(conn, config.runtime);
      if (problem) {
        setConfigOpen(true);
        setError(problem);
        return;
      }
      const target = currentId ? { id: currentId, project } : await createSession().then((created) => created && { id: created.session.id, project: created.project });
      if (!target) return;
      const framed = region && target.id === currentId ? region : null;
      const refs = outgoing?.refs ?? [];
      const files = outgoing?.files ?? [];
      const next = await sendAiEditMessage(conn, target.id, text, config, {
        region: framed && { time_us: framed.time_us, x: framed.x, y: framed.y, width: framed.width, height: framed.height, clip_ids: framed.clip_ids },
        // 片尾之后的时刻不发（小条上写着），发了后端会整条拒收
        refs: sendableRefs(refs, target.project).map(refRequest),
        attachments: attachmentRequests(files),
      });
      setInput("");
      if (framed) setRegionDraft((current) => (current?.sessionId === target.id ? null : current));
      // 这一排全部清掉（没发的片尾之后的时刻也清）；还没有剪辑时发的，这一排已经交给了新建的剪辑
      if (outgoing) setDraft((current) => clearSent(current, [outgoing.sessionId, target.id], { refs, files }));
      setState((current) => current?.session.id === next.id ? { ...current, session: next } : target.project ? { session: next, project: target.project } : current);
    } catch (reason) {
      setError(errorText(reason, "消息没发出去，请稍后重试。"));
    } finally {
      setSending(false);
    }
  };

  /** 存目标；还没有剪辑就先新建一个。成功返回 true，失败提示在错误条里 */
  const saveGoal = async (goal: string): Promise<boolean> => {
    if (!conn) return false;
    setError(null);
    try {
      const id = currentId ?? (await createSession())?.session.id;
      if (!id) return false;
      const next = await setAiEditGoal(conn, id, goal);
      setState((current) => current?.session.id === next.id ? { ...current, session: next } : current);
      return true;
    } catch (reason) {
      setError(errorText(reason, "目标没存上，请稍后重试。"));
      return false;
    }
  };

  /**
   * 看板上的手动改动、撤销、重做、换画面比例和左栏的退回都走这里：一次只发一个（锁被占时直接回 busy），
   * 回来的会话和工程直接换上。失败的原因交回给发起的地方：看板弹提示气泡，退回写进左栏的错误条。
   */
  const perform: EditPerformer = useCallback(async (call, fallback): Promise<EditOutcome> => {
    if (!conn || !currentId) return { ok: false, busy: false, message: "还没有剪辑。", code: null };
    if (editLock.current) return { ok: false, busy: true, message: IN_FLIGHT_REASON, code: "session_busy" };
    const id = currentId;
    editLock.current = true;
    setEditBusy(true);
    try {
      const next = await call(conn, id);
      revisionNow.current = next.project.revision;
      setState((current) => current?.session.id === next.session.id ? next : current);
      setSessions((list) => list.map((item) => item.id === next.session.id ? summaryOf(next.session) : item));
      return { ok: true, state: next };
    } catch (reason) {
      return { ok: false, busy: false, message: errorText(reason, fallback), code: (reason as { code?: string }).code ?? null };
    } finally {
      editLock.current = false;
      setEditBusy(false);
    }
  }, [conn, currentId]);
  const revert = async (messageId: string): Promise<boolean> => {
    setError(null);
    const outcome = await perform((connection, id) => revertAiEdit(connection, id, messageId), "没退回去，请稍后重试。");
    if (!outcome.ok) setError(outcome.message);
    return outcome.ok;
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

  /**
   * mode 不给是自动：有草稿就原位更新，草稿在剪映里被改过时先停下来问另存还是覆盖。
   * 上一个改动还没回来时不导、返回 false（看板提示稍等）：导出去的会是没带那一下的工程。
   */
  const exportDraft = (mode?: AiEditExportMode): boolean => {
    if (editLock.current) return false;
    if (conn && currentId) void writeDraft(conn, currentId, mode);
    return true;
  };
  const writeDraft = async (connection: NonNullable<typeof conn>, id: string, mode?: AiEditExportMode) => {
    // 记下发起导入的剪辑和当时的工程版本：请求回来时用户可能已经切走，提示只记到这个剪辑名下
    const revision = revisionNow.current;
    const note = (value: ExportNote) => setExportNotes((notes) => ({ ...notes, [id]: value }));
    setExportingIds((ids) => [...ids, id]);
    setExportNotes((notes) => { const next = { ...notes }; delete next[id]; return next; });
    setExportConflicts((all) => { if (!(id in all)) return all; const next = { ...all }; delete next[id]; return next; });
    try {
      const value = await exportAiEditSession(connection, id, mode);
      setState((current) => current && current.session.id === value.session.id ? { ...current, session: value.session } : current);
      setSessions((list) => list.map((item) => item.id === value.session.id ? summaryOf(value.session) : item));
      note({ revision: value.session.draftBox?.exportedRevision ?? revision, tone: "ok", text: value.result.created
        ? `${mode === "new" ? "已另存一份新草稿" : "已放进剪映草稿箱"}，名字是「${value.result.draftName}」，打开剪映就能看到。`
        : `已更新剪映里的「${value.result.draftName}」，重新打开这份草稿就是最新的。` });
    } catch (reason) {
      if ((reason as { code?: string }).code === "draft_changed") {
        setExportConflicts((all) => ({ ...all, [id]: errorText(reason, "剪映里的这份草稿在上次导入后被打开或改过。") }));
      } else note({ revision, tone: "warn", text: errorText(reason, "没能导入剪映草稿箱，请稍后重试。") });
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
    try {
      await deleteAiEditMedia(conn, id);
      setDraft((current) => dropMedia(current, id));
      await loadMedia();
    } catch (reason) { setError(errorText(reason, "没删掉，请稍后重试。")); }
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

  // AI 设置开着时左栏只有设置面板，引用、框选加上了也看不见：说一声。关掉设置时这句跟着撤掉
  const configHint = useRef<string | null>(null);
  const hintBehindConfig = useCallback((text: string) => { configHint.current = text; setError(text); }, []);
  useEffect(() => {
    const hint = configHint.current;
    if (configOpen || !hint) return;
    configHint.current = null;
    setError((current) => (current === hint ? null : current));
  }, [configOpen]);

  const pickRegion = useCallback((value: BoardRegion) => {
    if (!currentId) return;
    setRegionDraft({ sessionId: currentId, region: value });
    setLeftTab("chat");
    if (configOpenRef.current) hintBehindConfig("框好了，关掉 AI 设置就能在输入框上方看到。");
  }, [currentId, hintBehindConfig]);

  // ---------- 引用和附图（输入框上方那一排） ----------
  /** 改当前剪辑的那一排；原来那排是别的剪辑的，就从空的开始 */
  const changeOwnDraft = useCallback((owner: string | null, change: (current: ComposerDraft) => ComposerDraft) =>
    setDraft((current) => change(current.sessionId === owner ? current : emptyDraft(owner))), []);
  /** 引用到对话（看板右键菜单、详情卡、引用这一刻、点素材）：加到输入框上方，切回对话页签 */
  const refer = useCallback((more: readonly ComposerRef[]) => {
    const owner = currentIdRef.current;
    const own = draftRef.current.sessionId === owner ? draftRef.current.refs : NO_REFS;
    if (addRefs(own, more).dropped) setError(`一句话最多引用 ${MAX_MESSAGE_REFS} 样东西，多的没加上。`);
    else if (configOpenRef.current) hintBehindConfig("引用上了，关掉 AI 设置就能在输入框上方看到。");
    changeOwnDraft(owner, (current) => ({ ...current, refs: addRefs(current.refs, more).refs }));
    setLeftTab("chat");
  }, [changeOwnDraft, hintBehindConfig]);
  const unrefer = (ref: ComposerRef) => setDraft((current) => ({ ...current, refs: current.refs.filter((item) => refKey(item) !== refKey(ref)) }));
  /** 某个附件传了多少、传好了、画好了预览（patch 为 null 是没传上去，拿掉）；传好又不当图带的变成素材引用，引用满了说一声 */
  const patchFile = useCallback((key: string, patch: Partial<AttachDraft> | null) => {
    if (patchAttachment(draftRef.current, key, patch)?.dropped) setError(`一句话最多引用 ${MAX_MESSAGE_REFS} 样东西，多的文件只放进了素材库。`);
    setDraft((current) => patchAttachment(current, key, patch)?.draft ?? current);
  }, []);
  /** 贴进对话框、拖进对话区、点「附图」选的文件：都传进素材库；前 4 张图带给 AI 看，别的传完当素材引用 */
  const attachFiles = useCallback((files: File[]) => {
    if (!conn || !files.length) return;
    const owner = currentIdRef.current;
    const own = draftRef.current.sessionId === owner ? draftRef.current.files : NO_FILES;
    const plan = planAttachments(own.filter((file) => file.image).length, files);
    if (plan.filter(Boolean).length < files.filter(isImageFile).length) {
      setError(`一句话最多带 ${MAX_MESSAGE_ATTACHMENTS} 张图给 AI 看，多的放进了素材库，当成引用发过去。`);
    }
    const entries: AttachDraft[] = files.map((file, index) => ({ key: `attach-${++attachSequence}`, name: file.name, image: plan[index]!, progress: 0, mediaId: null }));
    changeOwnDraft(owner, (current) => ({ ...current, files: [...current.files, ...entries] }));
    files.forEach((file, index) => {
      const { key, image } = entries[index]!;
      uploadWatch.set(file, {
        progress: (ratio) => patchFile(key, { progress: ratio }),
        done: (item) => {
          // 先并进素材列表：变成引用的小条马上叫得出名字，不用等素材栏刷新回来
          setMedia((list) => (list.some((other) => other.id === item.id) ? list : [...list, item]));
          patchFile(key, { mediaId: item.id, progress: 1 });
        },
        // 没传上去的原因在错误条里，这一条直接拿掉
        fail: () => patchFile(key, null),
      });
      if (image) void imagePreview(file).then((preview) => patchFile(key, { preview }));
    });
    void uploadQueue.enqueue(conn, files);
    setLeftTab("chat");
  }, [conn, changeOwnDraft, patchFile]);
  const unattach = (key: string) => setDraft((current) => ({ ...current, files: current.files.filter((file) => file.key !== key) }));

  // 文件拖到左栏：对话页签里加进这句话，素材页签、设置里直接放进素材库；拖到页面别处的文件不让窗口打开它
  const dropRef = useRef<(files: File[]) => void>(() => undefined);
  dropRef.current = (files) => (leftTab === "chat" && !configOpen ? attachFiles(files) : uploadFiles(files));
  useEffect(() => {
    const zone = sideRef.current as unknown as HTMLElement | null;
    if (!web || !conn || !zone?.addEventListener) return undefined;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const inside = (event: DragEvent) => zone.contains(event.target as Node | null);
    let depth = 0;
    const enter = (event: DragEvent) => { if (carriesFiles(event)) { depth += 1; setDropping(true); } };
    const leave = (event: DragEvent) => { if (carriesFiles(event)) { depth = Math.max(0, depth - 1); if (!depth) setDropping(false); } };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = inside(event) ? "copy" : "none";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDropping(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (inside(event) && files.length) dropRef.current(files);
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [conn]);

  // ---------- 回复里的片段、时间 ----------
  const nameOf = useCallback((segment: EditSegment) => {
    const item = "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
    return clipCallName(segment, item ? mediaTitle(item) : null);
  }, [mediaById]);
  const jumpTo = useCallback((target: { clipId: string } | { timeUs: number }) => setJump((current) => ({ ...target, seq: (current?.seq ?? 0) + 1 })), []);
  const replyInline = useCallback<InlineRender>((text) => splitReplyRefs(text).map((piece, index) => {
    if (piece.kind === "text") return piece.text;
    const { label, found } = replyRefLabel(piece, project, nameOf);
    if (!found) return <Text key={index} style={styles.refGone}>{label}</Text>;
    const go = () => jumpTo(piece.kind === "clip" ? { clipId: piece.clipId } : { timeUs: piece.timeUs });
    return <Text key={index} accessibilityRole="link" accessibilityHint="在看板上跳过去" onPress={go} style={[styles.refLink, webPointer]}>{label}</Text>;
  }), [project, nameOf, jumpTo]);
  // 还在写的回复：写完的引用先换成说法，没写完的「[[…」藏起来
  const streamText = useCallback((text: string) => plainReplyRefs(hideOpenRef(text), (piece) => replyRefLabel(piece, project, nameOf).label), [project, nameOf]);
  const refLabelOf = (ref: ComposerRef) => composerRefLabel(ref, project, nameOf, (id) => { const item = mediaById.get(id); return item ? mediaTitle(item) : null; });

  if (!conn) return <View style={[styles.root, styles.gate]}>
    <Scissors size={34} color={color.accent} />
    <Text style={styles.gateTitle}>连接采集器后才能用 AI 剪辑</Text>
    <Text style={kit.body}>素材、对话和时间线都存在采集器里，做好后直接放进剪映草稿箱。</Text>
    <SmallButton label="前往连接" onPress={onOpenSettings} />
  </View>;

  const sessionBar = <View style={{ width: leftWidth }}>
    <SessionBar
      title={session?.title || (currentId ? "未命名剪辑" : "还没有剪辑")}
      open={menuOpen}
      configOpen={configOpen}
      onToggle={() => setMenuOpen((value) => !value)}
      onCreate={() => void createSession()}
      onToggleConfig={() => setConfigOpen((value) => !value)}
    />
  </View>;

  // 剪辑软件左上角那块：AI 对话一页、素材一页；点素材把它引用到对话里并回到对话
  const side = <View ref={sideRef} {...areaProps("outside", "e-box", "ai-panel", "ai-left")} style={[styles.left, { width: leftWidth }]}>
    {configOpen ? null : <View style={styles.tabs}>
      <Segmented small value={leftTab} onChange={setLeftTab} options={[{ label: "AI 对话", value: "chat" }, { label: media.length ? `素材 ${media.length}` : "素材", value: "media" }]} />
    </View>}
    {error ? <View accessibilityRole="alert" style={styles.errorBar}>
      <Text style={styles.errorText}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" hitSlop={8} onPress={() => setError(null)} style={webPointer}><X size={13} color={color.danger} /></Pressable>
    </View> : null}
    {configOpen
      ? <View style={styles.middle}><ConfigPanel
          connection={conn}
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
          onCancel={aiConfigReady(config) ? () => setConfigOpen(false) : undefined}
        /></View>
      : leftTab === "media"
        ? <MediaShelf
            media={media}
            uploads={uploads.tasks}
            mediaUrl={mediaUrl}
            onPick={(item) => refer([{ kind: "media", mediaId: item.id }])}
            onRemove={(id) => void removeMedia(id)}
            onOpenLibrary={() => setPickerOpen(true)}
            onUpload={uploadFiles}
          />
        : <>
          <GoalBar sessionId={currentId} goal={session?.goal ?? ""} onSave={saveGoal} />
          <View style={styles.middle}>
            <Conversation session={session} loaded={sessionsLoaded} running={running} editable={editable} mediaUrl={mediaUrl} inline={replyInline} streamText={streamText}
              onSuggest={(text) => setInput(text)} onRevert={revert} />
          </View>
          {region || shownRefs.length || shownFiles.length ? <View style={styles.tray}>
            {region ? <RegionHint region={region} onClear={() => setRegionDraft(null)} /> : null}
            {shownFiles.map((file) => <AttachChip key={file.key} file={file} onRemove={() => unattach(file.key)} />)}
            {shownRefs.map((ref) => <RefChip key={refKey(ref)} kind={ref.kind} label={refLabelOf(ref)} onRemove={() => unrefer(ref)}
              onShow={ref.kind === "clip" ? () => jumpTo({ clipId: ref.clipId }) : ref.kind === "time" ? () => jumpTo({ timeUs: ref.timeUs }) : undefined} />)}
          </View> : null}
          <Composer value={input} onChange={setInput} running={running} sending={sending} blocked={editBusy} uploading={uploading} onFiles={attachFiles} onSend={() => void send()} onStop={() => void stop()} />
        </>}
    {dropping ? <View pointerEvents="none" style={styles.dropMask}>
      <Text style={styles.dropText}>{leftTab === "chat" && !configOpen ? "松开就加进这句话：图片会带给 AI 看，别的文件放进素材库并引用" : "松开就放进素材库"}</Text>
    </View> : null}
    {menuOpen ? <SessionMenu sessions={sessions} currentId={currentId} onPick={(id) => { setCurrentId(id); setMenuOpen(false); }} onCreate={(canvas) => void createSession(canvas)} onRemove={(id) => void removeSession(id)} /> : null}
  </View>;

  return <View testID="ai-edit-workspace" style={styles.root}>
    <Board
      session={session}
      project={project}
      media={media}
      mediaUrl={mediaUrl}
      draftBox={draftBox}
      exporting={exporting}
      exportNote={exportNote}
      exportConflict={exportConflict}
      running={running}
      editable={editable}
      notEditableReason={notEditableReason}
      region={region}
      perform={perform}
      onRegion={pickRegion}
      onRefer={refer}
      jump={jump}
      onExport={exportDraft}
      onDismissConflict={() => {
        if (currentId) setExportConflicts((all) => { const next = { ...all }; delete next[currentId]; return next; });
      }}
      headStart={sessionBar}
      side={side}
      sideWidth={leftWidth}
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
    <Pressable {...ws("btn square", configOpen && "on")} accessibilityRole="button" accessibilityLabel="AI 设置" accessibilityState={{ expanded: configOpen }} onPress={onToggleConfig} style={[styles.iconButton, webPointer]}><Settings2 size={16} color={color.text} /></Pressable>
  </View>;
}

const MAX_GOAL_CHARS = 2000;

/** 这条片子的目标：每次都写进给 AI 的系统提示，对话再长被裁掉也还在；随时能改，清空保存就是删掉。 */
function GoalBar({ sessionId, goal, onSave }: { sessionId: string | null; goal: string; onSave: (goal: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal);
  const [saving, setSaving] = useState(false);
  // 换了剪辑就收起；自己保存时先新建了剪辑那次不收（没存上要留着编辑框和草稿）
  const savingRef = useRef(false);
  useEffect(() => { if (!savingRef.current) setEditing(false); }, [sessionId]);
  const save = async () => {
    savingRef.current = true;
    setSaving(true);
    const ok = await onSave(draft.trim());
    savingRef.current = false;
    setSaving(false);
    if (ok) setEditing(false);
  };
  if (editing) return <View {...ws("e-box")} style={styles.goalBox}>
    <View style={kit.row}>
      <Target size={14} color={color.accent} />
      <Text style={styles.goalLabel}>目标</Text>
      <Text style={[kit.muted, { flex: 1 }]}>每次都会带给 AI，对话再长也不会被裁掉</Text>
    </View>
    <TextInput
      accessibilityLabel="剪辑目标"
      multiline
      autoFocus
      value={draft}
      maxLength={MAX_GOAL_CHARS}
      onChangeText={setDraft}
      placeholder="比如：30 秒旅行卡点快闪，用「放空」这首歌，越往后切得越快，结尾停在海边"
      placeholderTextColor={color.textMuted}
      style={[styles.fieldInput, styles.goalInput]}
    />
    <View style={kit.row}>
      <SmallButton label={saving ? "保存中…" : "保存"} disabled={saving || draft.trim() === goal} onPress={() => void save()} />
      <SmallButton label="取消" onPress={() => { setDraft(goal); setEditing(false); }} />
    </View>
  </View>;
  return <Pressable
    {...ws("ai-goal")}
    accessibilityRole="button"
    accessibilityLabel={goal ? `剪辑目标：${goal}，点一下修改` : "设定剪辑目标"}
    onPress={() => { setDraft(goal); setEditing(true); }}
    style={[styles.goalRow, webPointer]}
  >
    <Target size={14} color={goal ? color.accent : color.textMuted} />
    {goal
      ? <Text numberOfLines={2} style={styles.goalText}>{goal}</Text>
      : <Text numberOfLines={1} style={[kit.muted, { flex: 1 }]}>定个目标，AI 每一步都照着做</Text>}
    <Text style={styles.linkText}>{goal ? "修改" : "设定"}</Text>
  </Pressable>;
}

function SessionMenu({ sessions, currentId, onPick, onCreate, onRemove }: {
  sessions: AiEditSessionSummary[]; currentId: string | null; onPick: (id: string) => void; onCreate: (canvas: EditCanvas) => void; onRemove: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return <View {...ws("e-box", "ai-float")} style={styles.menu}>
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

function ConfigPanel({ connection, config, probe, onSave, onRetest, onCancel }: {
  connection: ExploreConnection | null;
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
  const runtime = aiRuntimeOf(draft.runtime);
  const local = isLocalAiRuntime(runtime);
  const ready = aiConfigReady({ ...draft, runtime });
  const save = () => {
    // 测视频的结果交给外面按地址和模型决定沿不沿用；本机模型名也要去掉首尾空格
    const { videoInput: _input, videoProbe: _probe, localModels, ...rest } = draft;
    const models = localModels ? Object.fromEntries(Object.entries(localModels).map(([key, model]) => [key, (model ?? "").trim()])) : undefined;
    onSave({ ...rest, runtime, apiKey: draft.apiKey.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), ...(models ? { localModels: models } : {}) });
    setSaved(true);
  };
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.configScroll}>
    <View {...ws("e-box")} style={styles.configBox}>
      <Text style={styles.configTitle}>AI 设置</Text>
      <AiRuntimeField connection={connection} value={runtime} onChange={(next) => setDraft((current) => ({ ...current, runtime: next }))} />
      <Text style={kit.muted}>{local
        ? `用这台电脑上登录好的 ${RUNTIME_LABELS[runtime]} 来剪，走你自己的订阅，不用填 Key。它看不了视频，解析参考视频时应用会先把视频拆成镜头截图和音乐节拍再交给它，这时要开着应用。`
        : "AI 剪辑用自己的一套接口，和解析库的设置分开。模型要能调用工具，Key 只存在这台电脑上。"}</Text>
      {local ? <View style={styles.field}>
        <Text style={styles.label}>模型（选填）</Text>
        <TextInput accessibilityLabel="模型（选填）" value={draft.localModels?.[runtime] ?? ""} onChangeText={(text) => setDraft((current) => ({ ...current, localModels: { ...current.localModels, [runtime]: text } }))}
          placeholder={`留空就用 ${RUNTIME_LABELS[runtime]} 自己的默认模型`} placeholderTextColor={color.textMuted} style={styles.fieldInput} />
      </View> : <>
        {field("apiKey", "API Key", { secureTextEntry: true, placeholder: "从大模型服务商获取 API Key" })}
        {field("model", "模型", { placeholder: "doubao-seed-2-1-lite-260915" })}
        {field("baseUrl", "接口地址", { placeholder: "https://ark.cn-beijing.volces.com/api/v3" })}
      </>}
      <View style={kit.row}>
        <SmallButton label={saved ? "已保存" : "保存"} done={saved} disabled={!ready} onPress={save} />
        {onCancel ? <SmallButton label="收起" onPress={onCancel} /> : null}
      </View>
      {!local && !isLocalAiRuntime(config.runtime) && config.apiKey ? <View style={styles.probeRow}>
        <Text style={[kit.muted, { flex: 1 }]}>{videoInputNote(config, probe)}</Text>
        {probe.running ? <ActivityIndicator size="small" color={color.cyan} /> : <SmallButton label="重新测" onPress={onRetest} />}
      </View> : null}
    </View>
  </ScrollView>;
}

function Conversation({ session, loaded, running, editable, mediaUrl, inline, streamText, onSuggest, onRevert }: {
  session: AiEditSession | null; loaded: boolean; running: boolean; editable: boolean; mediaUrl: (id: string) => string | null;
  /** 回复里的片段、时间画成能点的 */
  inline: InlineRender;
  /** 还在写的回复怎么显示（引用换成说法） */
  streamText: (text: string) => string;
  onSuggest: (text: string) => void; onRevert: (messageId: string) => Promise<boolean>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const stick = useRef(true);
  const messages = session?.messages ?? [];
  const streaming = session?.streaming?.text ?? "";
  const liveActions = session?.streaming?.actions ?? [];
  const look = session?.streaming?.look;
  const busy = sessionRunning(session);
  // 「看不了图」只是提示，不算动手改了时间线
  const working = liveActions.some((action) => action.name !== "see_images");
  const revertible = useMemo(() => new Set(session?.revertible ?? []), [session?.revertible]);
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
    {SUGGESTIONS.map((text) => <Pressable key={text} {...ws("btn", "ai-suggest")} accessibilityRole="button" onPress={() => onSuggest(text)} style={[styles.suggestion, webPointer]}>
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
    {session?.trimmed ? <Text style={styles.note}>对话比较长了，更早几轮的细节 AI 只记得你当时说的话；一直要照着做的要求写进上面的目标更稳。</Text> : null}
    {messages.map((item) => <Message key={item.id} item={item} revertible={!running && revertible.has(item.id)} editable={editable} mediaUrl={mediaUrl} inline={inline} onRevert={onRevert} />)}
    {busy ? <View {...ws("c-bubble", "in")} style={[styles.bubble, styles.bubbleIn]}>
      {streaming ? <Markdown compact ink text={streamText(streaming)} /> : null}
      {liveActions.length ? <ActionList actions={liveActions} live /> : null}
      <View style={kit.row}><ActivityIndicator size="small" color={color.cyan} /><Text {...ws("ai-shimmer")} style={kit.muted}>{look ? (look.kind === "beats" ? "正在测配乐的节拍…" : "正在把参考视频拆成镜头截图和节拍，拆完交给 AI 看…") : working ? "正在改时间线…" : streaming ? "还在写…" : "AI 正在想…"}</Text></View>
    </View> : null}
    {session?.error ? <View accessibilityRole="alert" style={styles.sessionError}><Text style={styles.errorText}>{session.error.message}</Text></View> : null}
  </ScrollView>;
}

function Message({ item, revertible = false, editable = false, mediaUrl, inline, onRevert }: {
  item: AiEditChatItem; revertible?: boolean; editable?: boolean; mediaUrl?: (id: string) => string | null; inline?: InlineRender; onRevert?: (messageId: string) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!revertible) setConfirming(false); }, [revertible]);
  if (item.role === "note") return <Text style={styles.note}>{item.text}</Text>;
  const referred = item.role === "user" ? refsCaption(item.refs) : null;
  if (item.role === "user") return <View style={styles.ownLine}>
    {item.attachments?.length ? <View style={styles.ownImages}>
      {item.attachments.map((image, index) => <SentImage key={`${image.media_id}-${index}`} url={mediaUrl?.(image.media_id) ?? null} name={image.name} />)}
    </View> : null}
    <View {...ws("c-bubble", "own")} style={[styles.bubble, styles.bubbleOwn]}><Text selectable style={styles.bubbleText}>{item.text}</Text></View>
    {item.region ? <Text style={styles.ownMeta}>{regionCaption(item.region.time_us, item.region.labels)}</Text> : null}
    {referred ? <Text style={styles.ownMeta}>{referred}</Text> : null}
    {revertible && onRevert ? confirming
      ? <View style={styles.revertConfirm}>
        <Text style={styles.ownMeta}>这句话之后的改动都会撤掉，退回后还能撤销。</Text>
        <View style={kit.row}>
          <Pressable accessibilityRole="button" disabled={!editable} onPress={() => { setConfirming(false); void onRevert(item.id); }} style={[webPointer, !editable && styles.disabled]}><Text style={styles.dangerLink}>退回</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => setConfirming(false)} style={webPointer}><Text style={kit.muted}>取消</Text></Pressable>
        </View>
      </View>
      : <Pressable {...ws("ai-revert")} accessibilityRole="button" accessibilityLabel="把时间线退回到这句话之前" onPress={() => setConfirming(true)} style={webPointer}><Text style={styles.linkText}>退回到这句之前</Text></Pressable>
      : null}
  </View>;
  return <View {...ws("c-bubble", "in")} style={[styles.bubble, styles.bubbleIn]}>
    {item.text ? <Markdown compact text={item.text} inline={inline} /> : null}
    {item.actions?.length ? <ActionList actions={item.actions} /> : null}
  </View>;
}

/** AI 做过的步骤，小字列出；多了先收起（展开收起走 Expand 的平滑高度），正在进行的那一轮只看最近几步、新的一步淡入。 */
function ActionList({ actions, live = false }: { actions: AiEditAction[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // 正在进行的那一轮按总序号当 key：新到的一步是新挂上的，才有进场；滑出前四步的直接卸掉
  const first = live ? Math.max(0, actions.length - 4) : 0;
  const row = (action: AiEditAction, index: number) => <View key={index} {...ws("ai-step")} style={styles.actionRow}>
    <View style={styles.actionIcon}>{action.ok ? <Check size={12} color={color.green} /> : <X size={12} color={color.danger} />}</View>
    <Text style={[styles.actionText, !action.ok && { color: color.danger }]}>{action.summary}{!action.ok && action.error ? `：${action.error}` : ""}</Text>
  </View>;
  return <View {...ws("ai-steps")} style={styles.actions}>
    {live && first > 0 ? <Text style={styles.actionText}>前面已经做了 {first} 步</Text> : null}
    {actions.slice(first, live ? undefined : 4).map((action, index) => row(action, first + index))}
    {!live && actions.length > 4 ? <>
      <Expand open={expanded} gap={3}>{actions.slice(4).map((action, index) => row(action, 4 + index))}</Expand>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={webPointer}>
        <Text style={styles.linkText}>{expanded ? "收起" : `还有 ${actions.length - 4} 步`}</Text>
      </Pressable>
    </> : null}
  </View>;
}

function MediaShelf({ media, uploads, mediaUrl, onPick, onRemove, onOpenLibrary, onUpload }: {
  media: AiEditMediaItem[]; uploads: Array<{ key: string; name: string; progress: number }>; mediaUrl: (id: string) => string | null;
  onPick: (item: AiEditMediaItem) => void; onRemove: (id: string) => void; onOpenLibrary: () => void; onUpload: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  // 剪辑软件的素材区：两列网格，点一张把它提进消息里
  return <View style={styles.shelf}>
    <View style={styles.shelfHead}>
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
    {media.length || uploads.length ? <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.shelfGrid}>
      {uploads.map((item) => <View key={item.key} style={styles.card}>
        <View style={[styles.thumb, styles.thumbEmpty]}><Text style={styles.thumbProgress}>{Math.round(item.progress * 100)}%</Text></View>
        <Text numberOfLines={1} style={styles.cardName}>{item.name}</Text>
        <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} /></View>
      </View>)}
      {media.map((item) => <View key={item.id} style={styles.card}>
        <Pressable accessibilityRole="button" accessibilityLabel={`把「${mediaTitle(item)}」引用到对话`} disabled={item.status !== "ready"} onPress={() => onPick(item)} style={webPointer}>
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
    {media.length ? <Text style={[kit.muted, styles.shelfEmpty]}>点一个素材就引用到对话里，跟 AI 说「这个素材」它就知道是哪个。</Text> : null}
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

/** 输入框上方：画面上框了哪一块，发消息时一起带给 AI。 */
function RegionHint({ region, onClear }: { region: BoardRegion; onClear: () => void }) {
  return <View style={styles.regionHint}>
    <SquareDashed size={13} color={color.accent} />
    <Text numberOfLines={2} style={styles.regionHintText}>{regionHint(region.time_us, region.labels)}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="清除框选" hitSlop={8} onPress={onClear} style={webPointer}><Text style={styles.linkText}>清除</Text></Pressable>
  </View>;
}

/** 输入框上方的一条引用：点说法在看板上跳过去（片段、时刻），叉掉就不引用了 */
function RefChip({ kind, label, onRemove, onShow }: { kind: ComposerRef["kind"]; label: string; onRemove: () => void; onShow?: () => void }) {
  const icon = kind === "clip" ? <Scissors size={12} color={color.accent} /> : kind === "time" ? <Clock size={12} color={color.accent} /> : <Library size={12} color={color.accent} />;
  return <View style={styles.refChip}>
    {icon}
    {onShow
      ? <Pressable accessibilityRole="button" accessibilityLabel={`在看板上看${label}`} onPress={onShow} style={[styles.refChipLabel, webPointer]}><Text numberOfLines={1} style={styles.refChipText}>{label}</Text></Pressable>
      : <Text numberOfLines={1} style={[styles.refChipLabel, styles.refChipText]}>{label}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={`不引用${label}`} hitSlop={6} onPress={onRemove} style={webPointer}><X size={11} color={color.textMuted} /></Pressable>
  </View>;
}

/** 附的文件：图是一张小缩略图，别的文件写名字；传完之前盖着进度 */
function AttachChip({ file, onRemove }: { file: AttachDraft; onRemove: () => void }) {
  const percent = `${Math.round(file.progress * 100)}%`;
  const remove = <Pressable accessibilityRole="button" accessibilityLabel={`拿掉「${file.name}」`} hitSlop={6} onPress={onRemove} style={[styles.attachRemove, webPointer]}>
    <X size={10} color={color.white} />
  </Pressable>;
  if (!file.image) return <View style={styles.refChip}>
    <FolderOpen size={12} color={color.textMuted} />
    <Text numberOfLines={1} style={[styles.refChipLabel, styles.refChipText]}>{file.name}</Text>
    <Text style={styles.attachPercent}>{file.mediaId ? "" : percent}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`拿掉「${file.name}」`} hitSlop={6} onPress={onRemove} style={webPointer}><X size={11} color={color.textMuted} /></Pressable>
  </View>;
  return <View accessibilityLabel={file.mediaId ? `附图「${file.name}」` : `附图「${file.name}」正在上传 ${percent}`} style={styles.attach}>
    {file.preview ? <img src={file.preview} alt="" draggable={false} style={thumbMedia} /> : <ImageIcon size={16} color={color.textMuted} />}
    {file.mediaId && file.preview !== undefined ? null : <View style={styles.attachMask}><Text style={styles.attachProgress}>{file.mediaId ? "…" : percent}</Text></View>}
    {remove}
  </View>;
}

/** 用户气泡上方附的图：素材删了读不出来就画个图标 */
function SentImage({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return <View accessibilityLabel={`附图「${name}」`} style={styles.sentImage}>
    {url && !failed ? <img src={url} alt={name} title={name} draggable={false} style={thumbMedia} onError={() => setFailed(true)} /> : <ImageIcon size={16} color={color.textMuted} />}
  </View>;
}

/** 粘贴板里的文件（截图、从访达复制的文件、办公软件复制字时顺带的预览图） */
function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return data.files?.length ? Array.from(data.files)
    : Array.from(data.items ?? []).flatMap((item) => { const file = item.kind === "file" ? item.getAsFile() : null; return file ? [file] : []; });
}

/** 截图都叫 image.png，换个认得出的名字 */
function renamePasted(files: File[]): File[] {
  const now = new Date();
  return files.map((file) => { const name = pastedName(file.name, file.type, now); return name === file.name ? file : new File([file], name, { type: file.type }); });
}

function Composer({ value, onChange, running, sending, blocked, uploading, onFiles, onSend, onStop }: {
  value: string; onChange: (text: string) => void; running: boolean; sending: boolean;
  /** 看板上的手动改动还没回来，先不发 */
  blocked: boolean;
  /** 附的文件还没传完，先不发 */
  uploading: boolean;
  /** 贴进来的、点「附图」选的文件 */
  onFiles: (files: File[]) => void;
  onSend: () => void; onStop: () => void;
}) {
  const canSend = Boolean(value.trim()) && !running && !blocked && !uploading;
  const boxRef = useRef<View>(null);
  const pickRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  // 粘贴挂在外层的 DOM 上：输入框里的 paste 会冒泡上来；有文件才接走。纯文字、从 Excel / Word 复制的字（顺带一张预览图）照常粘贴
  useEffect(() => {
    const node = boxRef.current as unknown as HTMLElement | null;
    if (!web || !node?.addEventListener) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      const files = clipboardFiles(data);
      if (!files.length || (data && pasteIsRichText({ text: data.getData("text/plain"), html: data.getData("text/html"), files }))) return;
      event.preventDefault();
      filesRef.current(renamePasted(files));
    };
    node.addEventListener("paste", onPaste);
    return () => node.removeEventListener("paste", onPaste);
  }, []);
  return <View ref={boxRef} {...ws("c-composer")} style={styles.composer}>
    <Pressable {...ws("btn square")} accessibilityRole="button" accessibilityLabel="附图" onPress={() => pickRef.current?.click()} style={[styles.attachButton, webPointer]}>
      <ImagePlus size={16} color={color.textSecondary} />
    </Pressable>
    {web ? <input ref={pickRef} type="file" multiple accept="image/*" style={{ display: "none" }}
      onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length) onFiles(files); }} /> : null}
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
      placeholder={running ? "AI 正在剪，可以先想下一句" : uploading ? "图片还在传，传完就能发" : "说说想怎么剪（回车发送，能直接贴图）"}
      placeholderTextColor={color.textMuted}
      {...ws("c-input")}
      style={[styles.input, webAutoHeight]}
    />
    {running && !sending
      ? <Pressable {...ws("c-send", "on")} accessibilityRole="button" accessibilityLabel="停止" onPress={onStop} style={[styles.send, styles.sendReady, webPointer]}>
        <Square size={14} color={color.canvas} fill={color.canvas} />
      </Pressable>
      : <Pressable {...ws("c-send", canSend && "on")} accessibilityRole="button" accessibilityLabel={sending ? "正在发送" : uploading ? "等文件传完再发" : "发送"} accessibilityState={{ disabled: !canSend, busy: sending || uploading }} disabled={!canSend} onPress={onSend} style={[styles.send, canSend && styles.sendReady, webPointer]}>
        {sending || uploading ? <ActivityIndicator size="small" color={color.textMuted} /> : <Send size={16} color={canSend ? color.canvas : color.textMuted} />}
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
    <View {...ws("e-box", "ai-float")} style={styles.picker}>
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

// ============================== 样式 ==============================

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, flexDirection: "row", overflow: "hidden" },
  gate: { flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 40 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },

  left: { minHeight: 0, overflow: "hidden", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  tabs: { flexDirection: "row", paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6 },
  sessionBar: { flexDirection: "row", alignItems: "center", gap: 6 },
  sessionPick: { flex: 1, minWidth: 0, minHeight: 32, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: radius.small },
  sessionTitle: { flexShrink: 1, color: color.text, fontFamily: font.body, fontSize: 14, fontWeight: "600" },
  iconButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  goalRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  goalText: { flex: 1, color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 18 },
  goalBox: { gap: 8, margin: 10, marginBottom: 0, padding: 10, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  goalLabel: { color: color.text, fontFamily: font.body, fontSize: 13, fontWeight: "600" },
  goalInput: { minHeight: 76, paddingVertical: 8, textAlignVertical: "top" },
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
  ownLine: { alignItems: "flex-end", gap: 3 },
  ownMeta: { maxWidth: "88%", color: color.textMuted, fontFamily: font.body, fontSize: 10.5, lineHeight: 15, textAlign: "right" },
  revertConfirm: { alignItems: "flex-end", gap: 3 },
  note: { alignSelf: "center", maxWidth: "92%", paddingHorizontal: 12, color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 16, textAlign: "center" },
  bubble: { gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.medium },
  bubbleOwn: { maxWidth: "88%", borderTopRightRadius: 4, backgroundColor: color.cyanSoft },
  bubbleIn: { alignSelf: "stretch", borderTopLeftRadius: 4, backgroundColor: color.surfaceRaised },
  bubbleText: { color: color.text, fontFamily: font.body, fontSize: 12.5, lineHeight: 20 },
  actions: { gap: 3, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  // 按基线对齐：图标底边落在第一行字的基线上，各风格字号行高不同也对得齐
  actionRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  actionIcon: { width: 12, height: 12 },
  actionText: { flex: 1, color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 16 },
  sessionError: { padding: 10, borderRadius: radius.small, backgroundColor: color.dangerSoft },

  shelf: { flex: 1, minHeight: 0, gap: 6, paddingTop: 4, paddingBottom: 8 },
  shelfHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  shelfActions: { flexDirection: "row", gap: 6 },
  shelfGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
  shelfEmpty: { paddingHorizontal: 12, paddingVertical: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  chipText: { color: color.text, fontFamily: font.body, fontSize: 11, fontWeight: "600" },
  card: { width: "47%", gap: 2, position: "relative" },
  thumb: { width: "100%", aspectRatio: 16 / 10, overflow: "hidden", borderRadius: radius.small, position: "relative" },
  thumbEmpty: { alignItems: "center", justifyContent: "center", backgroundColor: color.surfaceMuted },
  thumbProgress: { color: color.textSecondary, fontFamily: font.mono, fontSize: 11 },
  cardName: { marginTop: 3, color: color.text, fontFamily: font.body, fontSize: 11.5, lineHeight: 16 },
  cardMeta: { color: color.textMuted, fontFamily: font.body, fontSize: 10, lineHeight: 13 },
  cardRemove: { position: "absolute", top: 3, right: 3, width: 16, height: 16, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: alpha(color.black, 0.55) },
  cardConfirm: { position: "absolute", top: 0, left: 0, right: 0, aspectRatio: 16 / 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, borderRadius: radius.small, backgroundColor: alpha(color.surface, 0.94) },
  progressTrack: { height: 3, borderRadius: 2, overflow: "hidden", backgroundColor: color.surfaceMuted },
  progressFill: { height: 3, backgroundColor: color.accentAction },

  tray: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingTop: 8 },
  regionHint: { width: "100%", flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.accentSoft },
  regionHintText: { flex: 1, minWidth: 0, color: color.text, fontFamily: font.body, fontSize: 11.5, lineHeight: 16 },
  refChip: { maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 8, paddingRight: 6, paddingVertical: 4, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.accentSoft },
  refChipLabel: { flexShrink: 1, minWidth: 0 },
  refChipText: { color: color.text, fontFamily: font.body, fontSize: 11.5, lineHeight: 16 },
  attach: { width: 44, height: 44, alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  attachMask: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: alpha(color.black, 0.45) },
  attachProgress: { color: color.white, fontFamily: font.mono, fontSize: 10 },
  attachPercent: { color: color.textMuted, fontFamily: font.mono, fontSize: 10 },
  attachRemove: { position: "absolute", top: 2, right: 2, width: 14, height: 14, alignItems: "center", justifyContent: "center", borderRadius: 7, backgroundColor: alpha(color.black, 0.6) },
  attachButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.medium },
  ownImages: { maxWidth: "88%", flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 4 },
  sentImage: { width: 56, height: 56, alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative", borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  refLink: { color: color.accentAction, textDecorationLine: "underline" },
  refGone: { color: color.textMuted },
  dropMask: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 8, alignItems: "center", justifyContent: "center", padding: 24, borderWidth: 2, borderStyle: "dashed", borderColor: color.accent, borderRadius: radius.medium, backgroundColor: alpha(color.surface, 0.92) },
  dropText: { color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 20, textAlign: "center" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 6, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
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
  disabled: { opacity: 0.45 },
});
