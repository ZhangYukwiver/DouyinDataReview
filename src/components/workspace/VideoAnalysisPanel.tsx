import React, { useEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { Clipboard, Download, Square, X } from "lucide-react-native";
import { loadAssistantConfig } from "../../services/assistant";
import { Markdown } from "./markdownView";
import type { ExploreConnection } from "../../services/explorer";
import {
  cancelVideoAnalysis, getVideoAnalysis, startVideoAnalysis,
  type VideoAnalysisEngine, type VideoAnalysisKind, type VideoAnalysisResponse, type VideoAnalysisResult,
} from "../../services/videoAnalysis";

const kinds = { script: "原片分镜脚本", notes: "学习笔记", transcript: "带时间戳的逐字稿" };
const engines = { bcut: "必剪", qwen: "Qwen3-ASR" };
const timestamp = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${Math.floor(ms / 100) % 10}`;
type Props = {
  connection: ExploreConnection; accountId?: string | null; videoId: string; title: string;
  onSeek?: (ms: number) => void; onClose: () => void; notify: (message: string) => void;
  initialNotes?: { key?: string };
};

function StudyArticle({ result, onSeek }: { result: VideoAnalysisResult; onSeek?: Props["onSeek"] }) {
  const root = useRef<HTMLElement>(null);
  const article = result.article!;
  const sections = [{ title: "视频核心观点", text: article.overview, startMs: undefined },
    ...result.entries.map((entry, i) => ({ title: `${i + 1}. ${entry.title}`, text: entry.text, startMs: entry.startMs })),
    { title: "AI 总结", text: article.summary, startMs: undefined }];
  return <article className="rv-study-article" ref={root}>
    <h1>{article.title}</h1>
    <details><summary>目录</summary><nav aria-label="笔记目录">{sections.map((section, i) =>
      <button key={i} onClick={() => root.current?.querySelector(`[data-chapter="${i}"]`)?.scrollIntoView({ block: "start" })}>{section.title}</button>)}</nav></details>
    {sections.map((section, i) => <section key={i} data-chapter={i}>
      <h2>{section.title}</h2>
      {onSeek && section.startMs != null && <button className="rv-analysis-time" onClick={() => onSeek(section.startMs!)}>查看原片 {timestamp(section.startMs)}</button>}
      <Markdown compact text={section.text} />
    </section>)}
  </article>;
}

export function VideoAnalysisDialog(props: Omit<Props, "notify">) {
  const [message, setMessage] = useState("");
  return <Modal transparent animationType="fade" visible onRequestClose={props.onClose}>
    <div className="rv-backdrop rv-library-analysis" role="dialog" aria-modal="true" aria-label="视频解析"
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
      <VideoAnalysisPanel {...props} notify={setMessage} />
      {message && <p className="rv-toast" role="status">{message}</p>}
    </div>
  </Modal>;
}

export function VideoAnalysisPanel({ connection, accountId, videoId, title, onSeek, onClose, notify, initialNotes }: Props) {
  const assistantNotes = Boolean(initialNotes);
  const [kind, setKind] = useState<VideoAnalysisKind>(assistantNotes ? "notes" : "script");
  const [engine, setEngine] = useState<VideoAnalysisEngine>("bcut");
  const [includeFrames, setIncludeFrames] = useState(false);
  const [config] = useState(() => loadAssistantConfig());
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
  const model = config.model || (config.runtime === "claude" ? "Claude Code" : config.runtime === "codex" ? "Codex" : "尚未设置");
  const transcriptCached = state.results.some(r => r.kind === "transcript" && r.engine === engine);
  const savedBcut = failed && job?.errorCode === "qwen_quota" && state.results.find(r => r.kind === "transcript" && r.engine === "bcut");
  const audioNotice = transcriptCached ? "复用已保存的逐字稿。" : `有声时将音轨发给${engines[engine]}。`;

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
        await startVideoAnalysis(connection, videoId, {
          kind: voice ? "notes" : kind, title, engine, withFrames: voice ? false : withFrames,
          config: kind === "transcript" && !voice ? undefined : config.runtime === "claude" || config.runtime === "codex"
            ? { runtime: config.runtime, model: config.model } : config,
        }, controller.signal, accountId);
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
    try { await navigator.clipboard.writeText(result.markdown); notify("解析结果已复制"); }
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
  return <section className="rv-analysis" data-analysis-panel aria-label="视频解析" onKeyDown={event => {
    event.stopPropagation(); if (event.key === "Escape") onClose();
  }}>
    <header className="rv-analysis-header"><div><strong>解析视频</strong><small>{title}</small></div>
      <button className="rv-icon-button" aria-label="关闭视频解析" onClick={onClose}><X color="#fff" size={18} /></button>
    </header>
    <div className="rv-analysis-options">
      <label><span>输出</span><select value={kind} disabled={pending || running} onChange={e => { setKind(e.target.value as VideoAnalysisKind); if (assistantNotes) selectKey(""); setError(""); }}>
        {Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label><span>转写</span><select value={engine} disabled={pending || running} onChange={e => { setEngine(e.target.value as VideoAnalysisEngine); if (assistantNotes) selectKey(""); setError(""); }}>
        {Object.entries(engines).map(([id, label]) => <option key={id} value={id}>{label}在线（免登录）</option>)}</select></label>
      {kind === "notes" && <label className="rv-analysis-check"><input type="checkbox" checked={includeFrames} disabled={pending || running}
        onChange={e => { setIncludeFrames(e.target.checked); if (assistantNotes) selectKey(""); }} /><span>结合画面</span></label>}
      <p className="rv-analysis-disclosure">{audioNotice}{kind === "script" ? `关键帧交给 ${model} 识别。` :
        kind === "notes" ? `${withFrames ? "关键帧和文字" : "转写文字"}交给 ${model} 整理。` : ""}</p>
      <div className="rv-analysis-actions">{running ?
        <button className="rv-button rv-analysis-stop" disabled={pending} onClick={() => void submit("cancel")}><Square size={13} />取消解析</button> :
        <button className="rv-button rv-analysis-start" disabled={pending || (kind === "transcript" && Boolean(result))}
          onClick={() => void submit("start")}>{failed ? "重试" : result?.kind === "notes" && !result.article ? "生成成篇笔记" : result ? kind === "transcript" ? "已保存逐字稿" : "按当前模型解析" : "开始解析"}</button>}
        {error && <button className="rv-text-button" onClick={() => refresh(v => v + 1)}>刷新状态</button>}
      </div>
    </div>
    {(running || job?.status === "cancelled") && <p className="rv-analysis-status" role="status">{running && <span className="rv-spinner-small" />}{job?.message}</p>}
    {(error || failed) && <p className="rv-analysis-error" role="alert">{error || job?.message}
      {savedBcut && <button className="rv-text-button" onClick={() => {
        setEngine("bcut"); setKind("transcript"); selectKey(savedBcut.key); setError("");
      }}>查看已保存的必剪逐字稿</button>}
      {failed && job?.errorCode === "vision_unsupported" && <button className="rv-text-button" onClick={() => void submit("voice")}>仅按口播生成笔记</button>}</p>}
    {initialNotes?.key && selectedKey === initialNotes.key && !pending && !error && !result &&
      <p className="rv-analysis-error" role="alert">找不到这版笔记，请返回后刷新已生成笔记。</p>}
    {result && <div className="rv-analysis-result">
      {matches.length > 1 && <select aria-label="已保存的版本" value={result.key} onChange={e => selectKey(e.target.value)}>
        {matches.map(r => <option key={r.key} value={r.key}>{r.model} · {new Date(r.createdAt).toLocaleString("zh-CN")}</option>)}</select>}
      <div className="rv-analysis-result-head"><span>{kinds[kind]} · {result.model || engines[engine]}</span>
        <div><button className="rv-text-button" onClick={() => void copy()}><Clipboard size={13} />复制</button><button className="rv-text-button" onClick={download}><Download size={13} />导出 Markdown</button></div></div>
      {result.article ? <StudyArticle result={result} onSeek={onSeek} /> : result.entries.length ? <ol className="rv-analysis-entries">{result.entries.map((entry, i) =>
        <li key={i}><button className="rv-analysis-time" disabled={!onSeek} onClick={() => onSeek?.(entry.startMs)}>{timestamp(entry.startMs)}</button>
          <div>{entry.title && <strong>{entry.title}</strong>}<p>{entry.text}</p></div></li>)}</ol> : <p>未识别到人声。</p>}
    </div>}
  </section>;
}
