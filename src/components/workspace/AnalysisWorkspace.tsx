import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ArrowUpRight, Copy, RefreshCw, Settings2, Sparkles, Trash2 } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import {
  deleteAnalysis, listAnalyses, loadAnalysisConfig, parseMarkdown, saveAnalysisConfig, startAnalysis,
  type AnalysisConfig, type VideoAnalysis,
} from "../../services/videoAnalysis";
import { Empty, ErrorLine, kit, Panel, SmallButton } from "./CreatorKit";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

// 解析库：粘贴链接或在视频卡片上点「解析」，采集器下载视频交给 AI 按创作者视角拆解，结果都留在这里。

type Props = { connection: ExploreConnection | null; onOpenRecord: (url: string) => Promise<void>; onOpenSettings: () => void };

const stageText = (item: VideoAnalysis) => item.status === "failed" ? "没解析成功"
  : item.status === "complete" ? "已解析" : item.stage === "analyzing" ? "AI 正在看视频…" : "正在下载视频…";

export function AnalysisWorkspace({ connection, onOpenRecord, onOpenSettings }: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 1000;
  const [items, setItems] = useState<VideoAnalysis[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [link, setLink] = useState("");
  const [config, setConfig] = useState<AnalysisConfig>(loadAnalysisConfig);
  const [editing, setEditing] = useState(() => !loadAnalysisConfig().apiKey);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase();
    if (!words) return items;
    return items.filter((item) => [item.video?.title, item.video?.author, item.video?.tags?.join(" "), item.markdown]
      .some((text) => text?.toLocaleLowerCase().includes(words)));
  }, [items, query]);
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;

  const start = async (url: string) => {
    if (!connection || !url.trim()) return;
    if (!config.apiKey) { setEditing(true); setError("先填好接口 Key 再解析。"); return; }
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
    <Text style={kit.body}>视频由采集器下载，再交给你设置的 AI 接口拆解。</Text><SmallButton label="前往连接" onPress={onOpenSettings} />
  </View></View>;

  return <ScrollView testID="analysis-workspace" style={styles.root} contentContainerStyle={[styles.content, width < 760 && styles.contentNarrow]}>
    <View {...ws("e-box")} style={styles.bar}>
      <TextInput accessibilityLabel="抖音视频链接" value={link} onChangeText={setLink} onSubmitEditing={() => void start(link)} editable={!starting} maxLength={500}
        placeholder="粘贴抖音视频链接，也可以在视频卡片上点「解析」" placeholderTextColor={color.textMuted} style={styles.input} />
      <SmallButton label={starting ? "提交中…" : "解析"} disabled={starting || !link.trim()} onPress={() => void start(link)}><Sparkles size={14} color={color.text} /></SmallButton>
      <SmallButton label="接口设置" onPress={() => setEditing((value) => !value)}><Settings2 size={14} color={color.text} /></SmallButton>
    </View>
    {editing ? <ConfigPanel config={config} onSave={(next) => { saveAnalysisConfig(next); setConfig(next); setEditing(false); setError(null); }} /> : null}
    {error ? <ErrorLine text={error} onRetry={() => { setError(null); void refresh(); }} /> : null}

    {!loaded ? <ActivityIndicator color={color.cyan} /> : items.length === 0 ? <Empty lines={["解析库还是空的。", "粘贴一条抖音视频链接，或者在观看历史、喜欢、收藏的卡片上点「解析」。"]} /> : <View style={[styles.columns, narrow && styles.columnsNarrow]}>
      <View style={[styles.list, narrow && styles.listNarrow]}>
        <TextInput accessibilityLabel="搜索解析库" value={query} onChangeText={setQuery} placeholder="搜标题、作者、词条或拆解内容" placeholderTextColor={color.textMuted} style={[styles.input, styles.search]} />
        <Text style={kit.muted}>{query.trim() ? `找到 ${shown.length} 条` : `一共解析了 ${items.length} 条视频`}</Text>
        {shown.map((item) => {
          const on = item.id === selected?.id;
          return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setSelectedId(item.id)} {...ws("e-box", on && "on")} style={[styles.item, on && styles.itemOn]}>
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

function ConfigPanel({ config, onSave }: { config: AnalysisConfig; onSave: (config: AnalysisConfig) => void }) {
  const [draft, setDraft] = useState(config);
  const field = (key: keyof AnalysisConfig, label: string, props: Partial<React.ComponentProps<typeof TextInput>> = {}) => <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={draft[key]} onChangeText={(text) => setDraft((current) => ({ ...current, [key]: text }))} placeholderTextColor={color.textMuted} style={[styles.input, styles.fieldInput, props.multiline && styles.multiline]} {...props} />
  </View>;
  return <Panel title="接口设置" subtitle="默认用火山方舟的豆包 Seed 2.1 lite，能看画面也能听声音，要先在方舟控制台开通。Key 只存在这台电脑上。">
    {field("apiKey", "API Key", { secureTextEntry: true, placeholder: "在火山方舟控制台的 API Key 管理里创建" })}
    {field("model", "模型", { placeholder: "doubao-seed-2-1-lite-260915" })}
    {field("baseUrl", "接口地址", { placeholder: "https://ark.cn-beijing.volces.com/api/v3" })}
    {field("direction", "我的创作方向（选填）", { multiline: true, maxLength: 600, placeholder: "比如：上班族的 10 分钟快手菜，口播加实拍。填了以后改编建议会贴着这个方向写。" })}
    <View style={kit.row}><SmallButton label="保存" disabled={!draft.apiKey.trim() || !draft.model.trim() || !draft.baseUrl.trim()} onPress={() => onSave({ ...draft, apiKey: draft.apiKey.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim() })} /></View>
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
  return <View {...ws("e-box")} style={styles.detail}>
    <Text style={styles.detailTitle}>{video?.title || "抖音视频"}</Text>
    <Text style={kit.muted}>{facts}</Text>
    {video?.tags?.length ? <Text style={kit.muted}>{video.tags.map((tag) => `#${tag}`).join("  ")}</Text> : null}
    <View style={kit.row}>
      <SmallButton label="打开原视频" onPress={onOpen}><ArrowUpRight size={14} color={color.text} /></SmallButton>
      {item.markdown ? <SmallButton label={copied ? "已复制" : "复制全文"} onPress={copy}><Copy size={14} color={color.text} /></SmallButton> : null}
      <SmallButton label="重新解析" disabled={item.status === "running"} onPress={onRetry}><RefreshCw size={14} color={color.text} /></SmallButton>
      <SmallButton label="删除" disabled={item.status === "running"} onPress={onRemove}><Trash2 size={14} color={color.text} /></SmallButton>
    </View>
    {item.status === "running" ? <View style={kit.row}><ActivityIndicator color={color.cyan} /><Text style={kit.body}>{stageText(item)}一条一般要几分钟，视频越长越久，可以先去看别的。</Text></View> : null}
    {item.error ? <ErrorLine text={item.markdown ? `${item.error}下面是上一次的结果。` : item.error} /> : null}
    {item.markdown ? <Markdown text={item.markdown} /> : null}
  </View>;
}

function Inline({ text, style }: { text: string; style?: object | object[] }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/u);
  return <Text selectable style={style}>{parts.map((part, index) => /^\*\*[^*]+\*\*$/u.test(part)
    ? <Text key={index} style={kit.strong}>{part.slice(2, -2)}</Text> : part)}</Text>;
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <View style={styles.markdown}>{blocks.map((block, index) => {
    if (block.kind === "h") return <Inline key={index} text={block.text} style={[styles.heading, block.level >= 3 && styles.headingSmall]} />;
    if (block.kind === "hr") return <View key={index} style={styles.hr} />;
    if (block.kind === "quote") return <Inline key={index} text={block.text} style={[kit.body, styles.quote]} />;
    if (block.kind === "li") return <View key={index} style={styles.li}><Text style={[kit.body, styles.marker]}>{block.marker}</Text><Inline text={block.text} style={[kit.body, { flex: 1 }]} /></View>;
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      return <View key={index} style={styles.table}>
        {block.rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.tr, rowIndex === 0 && styles.th]}>
          {Array.from({ length: columns }, (_, cell) => <View key={cell} style={styles.td}><Inline text={row[cell] ?? ""} style={rowIndex === 0 ? styles.thText : styles.tdText} /></View>)}
        </View>)}
      </View>;
    }
    return <Inline key={index} text={block.text} style={kit.body} />;
  })}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
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
  markdown: { gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: color.borderSoft },
  heading: { color: color.text, fontFamily: font.body, fontSize: 16, lineHeight: 26, fontWeight: "600", marginTop: 8 },
  headingSmall: { fontSize: 14 },
  hr: { height: 1, backgroundColor: color.borderSoft, marginVertical: 4 },
  quote: { paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: color.borderSoft, color: color.textMuted },
  li: { flexDirection: "row", gap: 8, paddingLeft: 4 },
  marker: { minWidth: 16, color: color.textMuted },
  table: { borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, overflow: "hidden" },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  th: { backgroundColor: color.surfaceRaised },
  td: { flex: 1, minWidth: 0, padding: 10, borderRightWidth: 1, borderRightColor: color.borderSoft },
  thText: { color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 19, fontWeight: "600" },
  tdText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, lineHeight: 20 },
});
