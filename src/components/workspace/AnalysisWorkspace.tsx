import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ArrowUpRight, Copy, RefreshCw, Settings2, Sparkles, Trash2 } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import { aiConfigReady, aiRuntimeOf, isLocalAiRuntime, probeAiEditVideo, videoProbeKey } from "../../services/aiEdit";
import {
  analysisLookUrl, answerAnalysisLook, deleteAnalysis, listAnalyses, loadAnalysisConfig, saveAnalysisConfig, startAnalysis,
  type AnalysisConfig, type VideoAnalysis,
} from "../../services/videoAnalysis";
import { dropLookJobs, runLookJob } from "./aiEditLook";
import { AiRuntimeField, RUNTIME_LABELS, runtimeProblem } from "./AiRuntimeField";
import { Empty, ErrorLine, kit, Panel, SmallButton } from "./CreatorKit";
import { Markdown } from "./markdownView";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

// 解析库：粘贴链接或在视频卡片上点「解析」，采集器下载视频交给 AI 按创作者视角拆解，结果都留在这里。

type Props = { connection: ExploreConnection | null; onOpenRecord: (url: string) => Promise<void>; onOpenSettings: () => void };

const stageText = (item: VideoAnalysis) => item.status === "failed" ? "没解析成功"
  : item.status === "complete" ? "已解析" : item.stage === "looking" ? "正在把视频拆成截图和节拍…"
    : item.stage === "analyzing" ? "AI 正在看视频…" : "正在下载视频…";

// 测模型能不能看视频：整个页面共用，切走再回来不重复测（「地址|模型|Key」）
const probing = new Set<string>();
const probeTried = new Set<string>();

type Probe = { key: string; running: boolean; error?: string };

function videoInputNote(config: AnalysisConfig, probe: Probe): string {
  if (probe.running) return "正在测这个模型能不能直接看视频……";
  const known = config.videoInput === true ? "这个模型能直接看视频，画面和声音都能用上。"
    : config.videoInput === false ? "这个模型看不了视频。解析时应用会先把视频拆成镜头截图和音乐节拍再交给它，听不到台词和旁白，这时要开着应用。"
      : null;
  if (probe.error) return known ? `这次没测出来（${probe.error}），先沿用上次的结果：${known}` : `没测出这个模型能不能直接看视频（${probe.error}）。解析时会先整段发给它，看不了再拆成截图。`;
  return known ?? "还没测过这个模型能不能直接看视频。";
}

export function AnalysisWorkspace({ connection, onOpenRecord, onOpenSettings }: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 1000;
  const [items, setItems] = useState<VideoAnalysis[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [link, setLink] = useState("");
  const [config, setConfig] = useState<AnalysisConfig>(loadAnalysisConfig);
  const [editing, setEditing] = useState(() => !aiConfigReady(loadAnalysisConfig()));
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [probe, setProbe] = useState<Probe>({ key: "", running: false });

  const refresh = useCallback(async () => {
    if (!connection) return;
    try {
      setItems(await listAnalyses(connection));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解析库没读到，请稍后重试。");
    } finally {
      setLoaded(true);
    }
  }, [connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  // 有解析中的就每 3 秒刷一次
  const running = items.some((item) => item.status === "running");
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  // 模型看不了视频时，采集器把活儿挂在解析记录上：这个页面在浏览器里拆好交回
  useEffect(() => {
    if (!connection) return;
    for (const item of items) {
      const look = item.status === "running" ? item.look ?? null : null;
      dropLookJobs(item.id, look?.id ?? null);
      if (look) runLookJob(item.id, look, analysisLookUrl(connection.baseUrl, look.url), (body) => answerAnalysisLook(connection, item.id, look.id, body));
    }
  }, [connection, items]);

  // 每个接口地址+模型测一次能不能看视频（保存时、以前存的没测过时）
  const configRef = useRef(config);
  configRef.current = config;
  const probeVideo = useCallback(async (target: AnalysisConfig) => {
    const key = videoProbeKey(target);
    const attempt = `${key}|${target.apiKey}`;
    if (!connection || probing.has(attempt)) return;
    probing.add(attempt);
    setProbe({ key, running: true });
    const settle = (next: Probe) => setProbe((current) => (current.key === key ? next : current));
    try {
      const { videoInput } = await probeAiEditVideo(connection, target);
      const stored = loadAnalysisConfig();
      if (videoProbeKey(stored) === key) saveAnalysisConfig({ ...stored, videoInput, videoProbe: key });
      setConfig((current) => (videoProbeKey(current) === key ? { ...current, videoInput, videoProbe: key } : current));
      settle({ key, running: false });
    } catch (reason) {
      settle({ key, running: false, error: reason instanceof Error ? reason.message : "没测出来，请稍后重试。" });
    } finally {
      probing.delete(attempt);
    }
  }, [connection]);
  useEffect(() => {
    const attempt = `${videoProbeKey(config)}|${config.apiKey}`;
    // 本机的 Codex / Claude Code 都看不了视频，不用测
    if (!connection || isLocalAiRuntime(config.runtime) || !config.apiKey.trim() || typeof config.videoInput === "boolean" || probeTried.has(attempt)) return;
    probeTried.add(attempt);
    void probeVideo(config);
  }, [connection, config, probeVideo]);

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    if (!words) return items;
    return items.filter((item) => [item.video?.title, item.video?.author, item.video?.tags?.join(" "), item.markdown]
      .some((text) => text?.toLocaleLowerCase().includes(words)));
  }, [items, query]);
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;

  const start = async (url: string) => {
    if (!connection || !url.trim()) return;
    if (!aiConfigReady(config)) { setEditing(true); setError("先在 AI 设置里填好 Key 和模型再解析。"); return; }
    const problem = await runtimeProblem(connection, config.runtime);
    if (problem) { setEditing(true); setError(problem); return; }
    setStarting(true);
    try {
      const entry = await startAnalysis(connection, url.trim(), config);
      setSelectedId(entry.id);
      setLink("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解析没开始，请稍后重试。");
    } finally {
      setStarting(false);
    }
  };
  const remove = async (id: string) => {
    if (!connection) return;
    try { await deleteAnalysis(connection, id); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "没删掉，请稍后重试。"); }
  };

  if (!connection) return <View style={styles.root}><View style={[styles.content, styles.gate]}>
    <Sparkles size={34} color={color.accent} /><Text style={styles.gateTitle}>连接采集器后才能解析视频</Text>
    <Text style={kit.body}>视频由采集器下载，再交给你设置的 AI 拆解。</Text><SmallButton label="前往连接" onPress={onOpenSettings} />
  </View></View>;

  return <ScrollView testID="analysis-workspace" style={styles.root} contentContainerStyle={[styles.content, width < 760 && styles.contentNarrow]}>
    <View {...ws("e-box", "an-bar")} style={styles.bar}>
      <TextInput accessibilityLabel="抖音视频链接" value={link} onChangeText={setLink} onSubmitEditing={() => void start(link)} editable={!starting} maxLength={500}
        placeholder="粘贴抖音视频链接，也可以在视频卡片上点「解析」" placeholderTextColor={color.textMuted} style={styles.input} />
      <SmallButton label={starting ? "提交中…" : "解析"} disabled={starting || !link.trim()} onPress={() => void start(link)}><Sparkles size={14} color={color.text} /></SmallButton>
      <SmallButton label="AI 设置" onPress={() => setEditing((value) => !value)}><Settings2 size={14} color={color.text} /></SmallButton>
    </View>
    {editing ? <ConfigPanel
      connection={connection}
      config={config}
      probe={probe.key === videoProbeKey(config) ? probe : { key: "", running: false }}
      onRetest={() => void probeVideo(configRef.current)}
      onSave={(saved) => {
        // 接口地址和模型没变就沿用测过的结果，变了会自动重测；面板留着显示测的结果
        const next = videoProbeKey(saved) === config.videoProbe ? { ...saved, videoInput: config.videoInput, videoProbe: config.videoProbe } : { ...saved, videoInput: undefined, videoProbe: undefined };
        saveAnalysisConfig(next);
        setConfig(next);
        setError(null);
      }}
      onClose={aiConfigReady(config) ? () => setEditing(false) : undefined}
    /> : null}
    {error ? <ErrorLine text={error} onRetry={() => { setError(null); void refresh(); }} /> : null}

    {!loaded ? <ActivityIndicator color={color.cyan} /> : items.length === 0 ? <Empty lines={["解析库还是空的。", "粘贴一条抖音视频链接，或者在观看历史、喜欢、收藏的卡片上点「解析」。"]} /> : <View style={[styles.columns, narrow && styles.columnsNarrow]}>
      <View style={[styles.list, narrow && styles.listNarrow]}>
        <TextInput accessibilityLabel="搜索解析库" value={query} onChangeText={setQuery} placeholder="搜标题、作者、词条或拆解内容" placeholderTextColor={color.textMuted} style={[styles.input, styles.search]} />
        <Text style={kit.muted}>{query.trim() ? `找到 ${shown.length} 条` : `一共解析了 ${items.length} 条视频`}</Text>
        {shown.map((item) => {
          const on = item.id === selected?.id;
          return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setSelectedId(item.id)} {...ws("e-box", "an-item", on && "on")} style={[styles.item, on && styles.itemOn]}>
            <Text numberOfLines={2} style={styles.itemTitle}>{item.video?.title || item.sourceUrl}</Text>
            <View style={kit.row}>
              {item.status === "running" ? <ActivityIndicator size="small" color={color.cyan} /> : null}
              <Text style={[kit.muted, item.status === "failed" && { color: color.danger }]}>{stageText(item)}</Text>
              {item.video?.author ? <Text numberOfLines={1} style={kit.muted}>· {item.video.author}</Text> : null}
            </View>
          </Pressable>;
        })}
      </View>
      {selected ? <Detail item={selected} onRetry={() => void start(selected.sourceUrl)} onRemove={() => void remove(selected.id)} onOpen={() => void onOpenRecord(selected.sourceUrl)} /> : null}
    </View>}
  </ScrollView>;
}

function ConfigPanel({ connection, config, probe, onSave, onRetest, onClose }: {
  connection: ExploreConnection | null;
  config: AnalysisConfig;
  probe: Probe;
  onSave: (config: AnalysisConfig) => void;
  onRetest: () => void;
  onClose?: () => void;
}) {
  const [draft, setDraft] = useState(config);
  // 保存后面板留着显示测的结果，按钮上闪一下「已保存」
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);
  const field = (key: "apiKey" | "model" | "baseUrl" | "direction", label: string, props: Partial<React.ComponentProps<typeof TextInput>> = {}) => <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={draft[key]} onChangeText={(text) => setDraft((current) => ({ ...current, [key]: text }))} placeholderTextColor={color.textMuted} style={[styles.input, styles.fieldInput, props.multiline && styles.multiline]} {...props} />
  </View>;
  const runtime = aiRuntimeOf(draft.runtime);
  const local = isLocalAiRuntime(runtime);
  const save = () => {
    const models = draft.localModels ? Object.fromEntries(Object.entries(draft.localModels).map(([key, model]) => [key, (model ?? "").trim()])) : undefined;
    onSave({ ...draft, runtime, apiKey: draft.apiKey.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), ...(models ? { localModels: models } : {}) });
    setSaved(true);
  };
  return <Panel title="AI 设置" subtitle={local
    ? `用这台电脑上登录好的 ${RUNTIME_LABELS[runtime]} 来解析，走你自己的订阅，不用填 Key。`
    : "填写解析用大模型的接口地址、模型名称和 API Key。模型最好能直接看视频（看不了的会改成看截图和节拍），Key 只存在这台电脑上。"}>
    <AiRuntimeField connection={connection} value={runtime} onChange={(next) => setDraft((current) => ({ ...current, runtime: next }))} />
    {local ? <View style={styles.field}>
      <Text style={styles.label}>模型（选填）</Text>
      <TextInput accessibilityLabel="模型（选填）" value={draft.localModels?.[runtime] ?? ""} onChangeText={(text) => setDraft((current) => ({ ...current, localModels: { ...current.localModels, [runtime]: text } }))}
        placeholder={`留空就用 ${RUNTIME_LABELS[runtime]} 自己的默认模型`} placeholderTextColor={color.textMuted} style={[styles.input, styles.fieldInput]} />
    </View> : <>
      {field("apiKey", "API Key", { secureTextEntry: true, placeholder: "从大模型服务商获取 API Key" })}
      {field("model", "模型", { placeholder: "doubao-seed-2-1-lite-260915" })}
      {field("baseUrl", "接口地址", { placeholder: "https://ark.cn-beijing.volces.com/api/v3" })}
    </>}
    {field("direction", "我的创作方向（选填）", { multiline: true, maxLength: 600, placeholder: "比如：上班族的 10 分钟快手菜，口播加实拍。填了以后改编建议会贴着这个方向写。" })}
    <View style={kit.row}>
      <SmallButton label={saved ? "已保存" : "保存"} done={saved} disabled={!aiConfigReady({ ...draft, runtime })} onPress={save} />
      {onClose ? <SmallButton label="收起" onPress={onClose} /> : null}
    </View>
    {local ? <Text style={kit.muted}>{`${RUNTIME_LABELS[runtime]} 看不了视频：解析时应用会先把视频拆成镜头截图和音乐节拍再交给它，听不到台词和旁白，这时要开着应用。`}</Text>
      : !isLocalAiRuntime(config.runtime) && config.apiKey ? <View style={styles.probeRow}>
        <Text style={[kit.muted, { flex: 1 }]}>{videoInputNote(config, probe)}</Text>
        {probe.running ? <ActivityIndicator size="small" color={color.cyan} /> : <SmallButton label="重新测" onPress={onRetest} />}
      </View> : null}
  </Panel>;
}

function Detail({ item, onRetry, onRemove, onOpen }: { item: VideoAnalysis; onRetry: () => void; onRemove: () => void; onOpen: () => void }) {
  const [copied, setCopied] = useState(false);
  const video = item.video;
  const facts = [
    video?.author,
    video?.durationSeconds ? `${video.durationSeconds} 秒` : null,
    video?.publishedAt ? `${new Date(video.publishedAt).toLocaleDateString("zh-CN")} 发布` : null,
    `${new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })} 解析`,
  ].filter(Boolean).join(" · ");
  const copy = () => {
    if (!item.markdown || Platform.OS !== "web") return;
    void navigator.clipboard?.writeText(item.markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  };
  return <View {...ws("e-box", "an-detail")} style={styles.detail}>
    <Text style={styles.detailTitle}>{video?.title || "抖音视频"}</Text>
    <Text style={kit.muted}>{facts}</Text>
    {video?.tags?.length ? <Text style={kit.muted}>{video.tags.map((tag) => `#${tag}`).join("  ")}</Text> : null}
    <View style={kit.row}>
      <SmallButton label="打开原视频" onPress={onOpen}><ArrowUpRight size={14} color={color.text} /></SmallButton>
      {item.markdown ? <SmallButton label={copied ? "已复制" : "复制全文"} done={copied} onPress={copy}><Copy size={14} color={color.text} /></SmallButton> : null}
      <SmallButton label="重新解析" disabled={item.status === "running"} onPress={onRetry}><RefreshCw size={14} color={color.text} /></SmallButton>
      <SmallButton label="删除" disabled={item.status === "running"} onPress={onRemove}><Trash2 size={14} color={color.text} /></SmallButton>
    </View>
    {item.status === "running" ? <View style={kit.row}><ActivityIndicator color={color.cyan} /><Text style={kit.body}>{stageText(item)}{item.stage === "looking" ? "这一步要开着应用（切到别的页面没关系），拆完再交给 AI。" : "一条一般要几分钟，视频越长越久，可以先去看别的。"}</Text></View> : null}
    {item.error ? <ErrorLine text={item.markdown ? `${item.error}下面是上一次的结果。` : item.error} /> : null}
    {item.markdown ? <Markdown text={item.markdown} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  probeRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: color.borderSoft },
  content: { padding: 32, gap: 18, paddingBottom: 70 },
  contentNarrow: { padding: 16 },
  gate: { alignItems: "center", gap: 14, paddingVertical: 60 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },
  bar: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface, flexWrap: "wrap" },
  input: { flex: 1, minWidth: 220, minHeight: 38, paddingHorizontal: 12, color: color.text, fontFamily: font.body, fontSize: 14, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  search: { flex: 0, minWidth: 0 },
  field: { gap: 6 },
  label: { color: color.textSecondary, fontFamily: font.body, fontSize: 12 },
  fieldInput: { flex: 0, minWidth: 0 },
  multiline: { minHeight: 70, paddingVertical: 10, textAlignVertical: "top" },
  columns: { flexDirection: "row", gap: 18, alignItems: "flex-start" },
  columnsNarrow: { flexDirection: "column", alignItems: "stretch" },
  list: { width: 300, gap: 8 },
  listNarrow: { width: "100%" },
  item: { gap: 6, padding: 12, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, backgroundColor: color.surface },
  itemOn: { borderColor: color.accent, backgroundColor: alpha(color.accent, 0.08) },
  itemTitle: { color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  detail: { flex: 1, minWidth: 0, alignSelf: "stretch", gap: 12, padding: 22, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  detailTitle: { color: color.text, fontFamily: font.body, fontSize: 18, lineHeight: 27, fontWeight: "600" },
});
