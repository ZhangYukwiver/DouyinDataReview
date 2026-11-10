import React, { useEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { Clipboard, Download, Square, X } from "lucide-react-native";
import { loadAssistantConfig, loadVideoModelConfig, resolveVideoModel, type AssistantConfig, type VideoModelConfig } from "../../services/assistant";
import { Markdown } from "./markdownView";
import type { ExploreConnection } from "../../services/explorer";
import {
  cancelVideoAnalysis, getVideoAnalysis, startVideoAnalysis, videoAnalysisBatch,
  type StartVideoAnalysisInput, type VideoAnalysisBatch, type VideoAnalysisBatchItem,
  type VideoAnalysisEngine, type VideoAnalysisKind, type VideoAnalysisResponse, type VideoAnalysisResult,
} from "../../services/videoAnalysis";

const kinds = { script: "原片分镜脚本", notes: "学习笔记", transcript: "带时间戳的逐字稿" };
// 排在前面的是首选：Qwen3-ASR 用不了时采集器自己改用必剪
const engines = { qwen: "Qwen3-ASR", bcut: "必剪" };
const modelName = (config: AssistantConfig) => config.model || (config.runtime === "claude" ? "Claude Code" : config.runtime === "codex" ? "Codex" : "尚未设置");
/** 每种输出各自用到什么，单条和批量说的是同一句 */
const needs = (kind: VideoAnalysisKind, withFrames: boolean, model: string, videoModel?: string) =>
  kind === "script" ? `优先把整段视频交给 ${videoModel ?? model} 拆镜头；它收不了视频时，改${videoModel ? `由 ${model} ` : "为"}逐张识别关键帧。台词取自语音转文字。`
    : kind === "notes" ? `语音转文字后，${withFrames ? "连同关键帧一起" : ""}交给 ${model} 整理；讲到要看画面的地方会配上原片截图。` : "只用语音转文字，不需要 AI 模型。";
/** 发给采集器的一次解析：逐字稿不带模型，本机 Codex / Claude Code 只带运行时和模型名，分镜另带视频模型 */
const analysisRequest = (kind: VideoAnalysisKind, engine: VideoAnalysisEngine, includeFrames: boolean, config: AssistantConfig, videoModel?: VideoModelConfig): StartVideoAnalysisInput => ({
  kind, engine, withFrames: kind === "script" || (kind === "notes" && includeFrames),
  config: kind === "transcript" ? undefined : config.runtime === "claude" || config.runtime === "codex" ? { runtime: config.runtime, model: config.model } : config,
  videoConfig: kind === "script" ? videoModel : undefined,
});
const timestamp = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${Math.floor(ms / 100) % 10}`;
type Props = {
  connection: ExploreConnection; accountId?: string | null; videoId: string; title: string;
  onSeek?: (ms: number) => void; onClose: () => void; notify: (message: string) => void;
  initialNotes?: { key?: string };
  /** 页面里单独弹出来的窗口（不是叠在播放器画面上）：跟着工作台风格走，带上各风格给弹窗的那套样式 */
  dialog?: boolean;
};

function StudyArticle({ result, onSeek }: { result: VideoAnalysisResult; onSeek?: Props["onSeek"] }) {
  const root = useRef<HTMLElement>(null);
  const article = result.article!;
  const sections: { title: string; text: string; startMs?: number; figure?: string }[] = [{ title: "视频核心观点", text: article.overview },
    ...result.entries.map((entry, i) => ({ title: `${i + 1}. ${entry.title}`, text: entry.text, startMs: entry.startMs, figure: entry.figure })),
    { title: "AI 总结", text: article.summary }];
  return <article className="rv-study-article" ref={root}>
    <h1>{article.title}</h1>
    <details><summary>目录</summary><nav aria-label="笔记目录">{sections.map((section, i) =>
      <button key={i} onClick={() => root.current?.querySelector(`[data-chapter="${i}"]`)?.scrollIntoView({ block: "start" })}>{section.title}</button>)}</nav></details>
    {sections.map((section, i) => <section key={i} data-chapter={i}>
      <h2>{section.title}</h2>
      {onSeek && section.startMs != null && <button className="rv-analysis-time" onClick={() => onSeek(section.startMs!)}>查看原片 {timestamp(section.startMs)}</button>}
      {section.figure && <img className="rv-study-figure" src={section.figure} alt={`「${section.title}」的原片截图`} />}
      <Markdown compact text={section.text} />
    </section>)}
  </article>;
}

export function VideoAnalysisDialog(props: Omit<Props, "notify">) {
  const [message, setMessage] = useState("");
  return <Modal transparent animationType="fade" visible onRequestClose={props.onClose}>
    <div className="rv-backdrop rv-library-analysis" role="dialog" aria-modal="true" aria-label="视频解析"
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
      <VideoAnalysisPanel {...props} dialog notify={setMessage} />
      {message && <p className="rv-toast" role="status">{message}</p>}
    </div>
  </Modal>;
}

const batchStatus: Record<VideoAnalysisBatchItem["status"], string> = { waiting: "排队中", running: "解析中", completed: "已完成", failed: "没成功", cancelled: "已停止" };

/**
 * 批量解析：勾选的视频交给采集器排队，一条做完再做下一条；这个窗口只是看进度的，关掉也接着跑。
 * items 是刚勾选的视频；空的就是回来看正在跑（或刚跑完）的那一批。
 */
export function VideoAnalysisBatchDialog({ connection, accountId, items, onClose, onRunning, onStarted }: {
  connection: ExploreConnection; accountId?: string | null; items: Pick<VideoAnalysisBatchItem, "videoId" | "title">[];
  onClose: () => void; onRunning: (running: boolean) => void; onStarted: () => void;
}) {
  const [kind, setKind] = useState<VideoAnalysisKind>("notes");
  const [engine, setEngine] = useState<VideoAnalysisEngine>("qwen");
  const [includeFrames, setIncludeFrames] = useState(false);
  const [config] = useState(() => loadAssistantConfig());
  const [videoModel] = useState(() => resolveVideoModel(loadVideoModelConfig(), config));
  // undefined 是还没读到
  const [batch, setBatch] = useState<VideoAnalysisBatch | null>();
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [viewing, view] = useState<VideoAnalysisBatchItem | null>(null);
  const running = batch?.status === "running";
  // 有一批在跑就先看它；没在跑、手里又有刚勾选的，才是开新的一批
  const setup = batch !== undefined && !running && !started && items.length > 0;
  const rows = batch?.items ?? [];
  const count = (status: VideoAnalysisBatchItem["status"]) => rows.filter(item => item.status === status).length;
  const unfinished = count("failed") + count("cancelled");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await videoAnalysisBatch(connection, null, controller.signal, accountId);
        if (controller.signal.aborted) return;
        setBatch(next); onRunning(next?.status === "running");
        if (next?.status === "running") timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setBatch(current => current ?? null);
        setError(cause instanceof Error ? cause.message : "读取批量解析的进度失败。");
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [connection.baseUrl, connection.token, accountId, revision]);

  async function act(action: Parameters<typeof videoAnalysisBatch>[1]) {
    setBusy(true); setError("");
    try {
      setBatch(await videoAnalysisBatch(connection, action, undefined, accountId));
      if (!started) onStarted();
      setStarted(true);
      refresh(v => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量解析请求失败，请重试。");
    } finally { setBusy(false); }
  }

  if (viewing) return <VideoAnalysisDialog connection={connection} accountId={accountId} videoId={viewing.videoId} title={viewing.title || `视频 ${viewing.videoId}`} onClose={() => view(null)} />;
  return <Modal transparent animationType="fade" visible onRequestClose={onClose}>
    <div className="rv-backdrop rv-library-analysis" role="dialog" aria-modal="true" aria-label="批量解析"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="rv-analysis" data-analysis-batch data-ws="w-dialog" aria-label="批量解析" onKeyDown={event => {
        event.stopPropagation(); if (event.key === "Escape") onClose();
      }}>
        <header className="rv-analysis-header"><div><strong>批量解析</strong>
          <small>{setup ? `已选 ${items.length} 条视频` : rows.length ? `${kinds[batch!.kind]} · 已完成 ${count("completed")} / ${rows.length}${count("failed") ? `，${count("failed")} 条没成功` : ""}` : ""}</small></div>
          <button className="rv-icon-button" aria-label="关闭批量解析" onClick={onClose}><X size={18} /></button>
        </header>
        {setup ? <div className="rv-analysis-options">
          <label><span>输出</span><select value={kind} disabled={busy} onChange={e => setKind(e.target.value as VideoAnalysisKind)}>
            {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label><span>转写</span><select value={engine} disabled={busy} onChange={e => setEngine(e.target.value as VideoAnalysisEngine)}>
            {Object.entries(engines).map(([id, label]) => <option key={id} value={id}>{label}在线（免登录）</option>)}</select></label>
          {kind === "notes" && <label className="rv-analysis-check"><input type="checkbox" checked={includeFrames} disabled={busy}
            onChange={e => setIncludeFrames(e.target.checked)} /><span>结合画面</span></label>}
          <p className="rv-analysis-disclosure">{needs(kind, kind === "script" || (kind === "notes" && includeFrames), modelName(config), videoModel?.model)}
            整批都按这一种做，排队一条一条来，做过的直接算完成。开始后可以关掉这个窗口接着用，回来点「解析进度」看。</p>
          <div className="rv-analysis-actions">
            <button className="rv-button rv-analysis-start" disabled={busy} onClick={() => void act({ ...analysisRequest(kind, engine, includeFrames, config, videoModel), items })}>开始解析（{items.length} 条）</button>
          </div>
        </div> : batch === undefined ? <p className="rv-analysis-status" role="status"><span className="rv-spinner-small" />正在读取进度</p>
          : !rows.length ? <p className="rv-analysis-status" role="status">现在没有在跑的批量解析。在内容库点「批量解析」勾选视频就能开一批。</p>
          : <>
            <div className="rv-analysis-options">
              <p className="rv-analysis-disclosure rv-analysis-batch-note">{running ? `正在一条一条做，关掉这个窗口也会接着跑。${items.length && !started ? "上一批还没做完，等它做完或停掉再开新的一批。" : ""}` : "这一批做完了，结果存在各条视频自己名下。"}</p>
              <div className="rv-analysis-actions">
                {running ? <button className="rv-button rv-analysis-stop" disabled={busy} onClick={() => void act("stop")}><Square size={13} />停止这一批</button>
                  : unfinished > 0 && <button className="rv-button rv-analysis-start" disabled={busy} onClick={() => void act({ retry: true })}>重试没成的（{unfinished} 条）</button>}
              </div>
            </div>
            <div className="rv-analysis-result"><ol className="rv-analysis-entries rv-analysis-batch">{rows.map(item =>
              <li key={item.videoId} data-status={item.status}><span>{batchStatus[item.status]}</span>
                <div><strong>{item.title || `视频 ${item.videoId}`}</strong>{item.message && <p>{item.message}</p>}</div>
                {item.status === "completed" ? <button className="rv-text-button" onClick={() => view(item)}>查看</button>
                  : (item.status === "failed" || item.status === "cancelled") && <button className="rv-text-button" disabled={busy} onClick={() => void act({ retry: item.videoId })}>重试</button>}
              </li>)}</ol></div>
          </>}
        {error && <p className="rv-analysis-error" role="alert">{error}</p>}
      </section>
    </div>
  </Modal>;
}

export function VideoAnalysisPanel({ connection, accountId, videoId, title, onSeek, onClose, notify, initialNotes, dialog }: Props) {
  const assistantNotes = Boolean(initialNotes);
  const [kind, setKind] = useState<VideoAnalysisKind>(assistantNotes ? "notes" : "script");
  const [engine, setEngine] = useState<VideoAnalysisEngine>("qwen");
  const [includeFrames, setIncludeFrames] = useState(false);
  const [config] = useState(() => loadAssistantConfig());
  const [videoModel] = useState(() => resolveVideoModel(loadVideoModelConfig(), config));
  const [state, setState] = useState<VideoAnalysisResponse>({ job: null, results: [] });
  const [selectedKey, selectKey] = useState(initialNotes?.key ?? "");
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const firstRead = useRef(true);
  const read = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const job = state.job;
  const withFrames = kind === "script" || (kind === "notes" && includeFrames);
  const running = job?.status === "running";
  const matches = state.results.filter(r => r.kind === kind && r.engine === engine && r.withFrames === withFrames);
  const result = selectedKey
    ? matches.find(r => r.key === selectedKey) ?? (assistantNotes ? undefined : matches[0])
    : matches[0];
  const failed = job?.status === "failed" && job.kind === kind && job.engine === engine && job.withFrames === withFrames;
  const model = modelName(config);
  const transcriptCached = state.results.some(r => r.kind === "transcript" && r.engine === engine);
  const audioNotice = transcriptCached ? "复用已保存的逐字稿。" : engine === "qwen" ? "有声时将音轨发给 Qwen3-ASR，它用不了时改发必剪。" : "有声时将音轨发给必剪。";

  useEffect(() => {
    const controller = new AbortController();
    read.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await getVideoAnalysis(connection, videoId, controller.signal, accountId);
        if (controller.signal.aborted) return;
        if (firstRead.current) {
          let last: typeof next.job | VideoAnalysisResult | undefined = next.job ?? next.results[0];
          if (initialNotes?.key) last = next.results.find(r => r.kind === "notes" && r.key === initialNotes.key);
          else if (assistantNotes) {
            last = next.job?.kind === "notes" && next.job.status === "running" ? next.job : next.results.find(r => r.kind === "notes");
          }
          if (last) {
            setKind(last.kind); setEngine(last.engine); setIncludeFrames(last.kind === "notes" && last.withFrames);
            selectKey("key" in last ? last.key : last.resultKey ?? "");
          }
          firstRead.current = false;
        } else if (next.job?.note) {
          // 采集器把 Qwen3-ASR 换成了必剪：面板跟着切过去，才对得上它存下的结果
          setEngine(next.job.engine); selectKey(next.job.resultKey ?? "");
        }
        setState(next); setPending(false); setError("");
        if (next.job?.status === "running") timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setPending(false);
          setError(cause instanceof Error ? cause.message : "读取解析状态失败。");
        }
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [connection.baseUrl, connection.token, accountId, videoId, revision, assistantNotes, initialNotes?.key]);
  useEffect(() => () => action.current?.abort(), []);

  async function submit(operation: "start" | "cancel" | "voice") {
    if (action.current) return;
    read.current?.abort();
    const controller = new AbortController();
    action.current = controller;
    setPending(true); setError("");
    const voice = operation === "voice";
    if (voice) { setKind("notes"); setIncludeFrames(false); }
    try {
      const next = operation === "cancel" ? await cancelVideoAnalysis(connection, videoId, controller.signal, accountId) :
        await startVideoAnalysis(connection, videoId, { ...analysisRequest(voice ? "notes" : kind, engine, !voice && includeFrames, config, videoModel), title }, controller.signal, accountId);
      if (controller.signal.aborted) return;
      setState(next); selectKey(next.job?.resultKey ?? "");
      refresh(v => v + 1);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "解析请求失败，请重试。");
    } finally {
      if (!controller.signal.aborted) setPending(false);
      action.current = null;
    }
  }
  async function copy() {
    if (!result) return;
    // 配图是整张图片的编码，贴进文字里没法看；要带图用「导出 Markdown」
    try { await navigator.clipboard.writeText(result.markdown.replace(/!\[[^\n]*\]\(data:image\/[^)\s]+\)\n\n/gu, "")); notify("解析结果已复制"); }
    catch { notify("复制失败，请手动选择文本"); }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(result.article?.title || title || videoId).replace(/[\\/:*?"<>|]/gu, "_").slice(0, 80)}-${kinds[kind]}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return <section className="rv-analysis" data-analysis-panel data-ws={dialog ? "w-dialog" : undefined} aria-label="视频解析" onKeyDown={event => {
    event.stopPropagation(); if (event.key === "Escape") onClose();
  }}>
    <header className="rv-analysis-header"><div><strong>解析视频</strong><small>{title}</small></div>
      <button className="rv-icon-button" aria-label="关闭视频解析" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="rv-analysis-options">
      <label><span>输出</span><select value={kind} disabled={pending || running} onChange={e => { setKind(e.target.value as VideoAnalysisKind); if (assistantNotes) selectKey(""); setError(""); }}>
        {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label><span>转写</span><select value={engine} disabled={pending || running} onChange={e => { setEngine(e.target.value as VideoAnalysisEngine); if (assistantNotes) selectKey(""); setError(""); }}>
        {Object.entries(engines).map(([id, label]) => <option key={id} value={id}>{label}在线（免登录）</option>)}</select></label>
      {kind === "notes" && <label className="rv-analysis-check"><input type="checkbox" checked={includeFrames} disabled={pending || running}
        onChange={e => { setIncludeFrames(e.target.checked); if (assistantNotes) selectKey(""); }} /><span>结合画面</span></label>}
      <p className="rv-analysis-disclosure">{needs(kind, withFrames, model, videoModel?.model)}{audioNotice}</p>
      <div className="rv-analysis-actions">{running ?
        <button className="rv-button rv-analysis-stop" disabled={pending} onClick={() => void submit("cancel")}><Square size={13} />取消解析</button> :
        <button className="rv-button rv-analysis-start" disabled={pending || (kind === "transcript" && Boolean(result))}
          onClick={() => void submit("start")}>{failed ? "重试" : result?.kind === "notes" && !result.article ? "生成成篇笔记" : result ? kind === "transcript" ? "已保存逐字稿" : "按当前模型解析" : "开始解析"}</button>}
        {error && <button className="rv-text-button" onClick={() => refresh(v => v + 1)}>刷新状态</button>}
      </div>
    </div>
    {(running || job?.status === "cancelled") && <p className="rv-analysis-status" role="status">{running && <span className="rv-spinner-small" />}{job?.message}</p>}
    {!running && job?.note && job.kind === kind && job.engine === engine && <p className="rv-analysis-status" role="status">{job.note}</p>}
    {(error || failed) && <p className="rv-analysis-error" role="alert">{error || job?.message}
      {failed && job?.errorCode === "vision_unsupported" && <button className="rv-text-button" onClick={() => void submit("voice")}>仅按口播生成笔记</button>}</p>}
    {initialNotes?.key && selectedKey === initialNotes.key && !pending && !error && !result &&
      <p className="rv-analysis-error" role="alert">找不到这版笔记，请返回后刷新已生成笔记。</p>}
    {result && <div className="rv-analysis-result">
      {matches.length > 1 && <select aria-label="已保存的版本" value={result.key} onChange={e => selectKey(e.target.value)}>
        {matches.map(r => <option key={r.key} value={r.key}>{r.model} · {new Date(r.createdAt).toLocaleString("zh-CN")}</option>)}</select>}
      <div className="rv-analysis-result-head"><span>{kinds[kind]} · {result.model || engines[engine]}{kind === "script" && (result.source === "video" ? " · 看整段视频" : " · 看关键帧")}</span>
        <div><button className="rv-text-button" onClick={() => void copy()}><Clipboard size={13} />复制</button><button className="rv-text-button" onClick={download}><Download size={13} />导出 Markdown</button></div></div>
      {result.article ? <StudyArticle result={result} onSeek={onSeek} /> : result.entries.length ? <ol className="rv-analysis-entries">{result.entries.map((entry, i) =>
        <li key={i}><button className="rv-analysis-time" disabled={!onSeek} onClick={() => onSeek?.(entry.startMs)}>{timestamp(entry.startMs)}</button>
          <div>{entry.title && <strong>{entry.title}</strong>}<p>{entry.text}</p></div></li>)}</ol> : <p>未识别到人声。</p>}
    </div>}
  </section>;
}
