import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { BookOpenText, ChevronRight } from "lucide-react-native";
import type { PersonalRecordCollection } from "../../domain/personalRecords";
import { assistantConfigReady, loadAssistantConfig } from "../../services/assistant";
import type { ExploreConnection } from "../../services/explorer";
import {
  askKnowledge, getKnowledge, getKnowledgeModel, KnowledgeEmbedder, pendingPassages, prepareKnowledgeModel, saveVectors, searchKnowledge,
  type KnowledgeAnswer, type KnowledgeHit, type KnowledgeModelState, type KnowledgeView,
} from "../../services/knowledge";
import { analysisVideoIdOf } from "../../services/videoFeed";
import { Empty, ErrorLine, kit, Loading, SmallButton } from "./CreatorKit";
import { Markdown } from "./markdownView";
import { VideoAnalysisDialog } from "./VideoAnalysisPanel";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { ws } from "./motion";

type Props = { connection: ExploreConnection | null; accountId: string | null; records: PersonalRecordCollection; onOpenSettings: () => void; onOpenAiSettings: () => void };
type Semantic = { phase: "off" | "downloading" | "loading" | "embedding" | "ready" | "failed"; message: string };

const kindLabel = { transcript: "逐字稿", notes: "学习笔记", script: "分镜脚本" } as const;
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const AI_NOTICE = "先到「设置 → AI」填好模型，再向知识库提问。";
const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export function KnowledgeWorkspace({ connection: given, accountId, records, onOpenSettings, onOpenAiSettings }: Props) {
  // 外壳每次重渲染都会新建连接对象：按地址和令牌认，不然下面的读取和向量计算会被反复打断重来
  const baseUrl = given?.baseUrl, token = given?.token;
  const connection = useMemo(() => (baseUrl && token ? { baseUrl, token } : null), [baseUrl, token]);
  const [view, setView] = useState<KnowledgeView | null>(null);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [model, setModel] = useState<KnowledgeModelState | null>(null);
  const [semantic, setSemantic] = useState<Semantic>({ phase: "off", message: "" });
  const [semanticTry, retrySemantic] = useState(0);
  const embedder = useRef<KnowledgeEmbedder | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"" | "search" | "ask">("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [answer, setAnswer] = useState<(KnowledgeAnswer & { question: string }) | null>(null);
  const [notice, setNotice] = useState("");
  const [opened, open] = useState<{ videoId: string; title: string } | null>(null);
  const asking = useRef<AbortController | null>(null);

  const titles = useMemo(() => {
    const index = new Map<string, string>();
    for (const list of Object.values(records)) for (const record of list) {
      const id = analysisVideoIdOf(record);
      if (id && record.title && !index.has(id)) index.set(id, record.title);
    }
    return index;
  }, [records]);
  const titleOf = (item: { videoId: string; title: string }) => item.title || titles.get(item.videoId) || `视频 ${item.videoId}`;

  // 收录了哪些解析、算了多少向量
  useEffect(() => {
    if (!connection) return undefined;
    const controller = new AbortController();
    setError("");
    getKnowledge(connection, accountId, controller.signal).then(setView, cause => { if (!controller.signal.aborted) setError(message(cause, "读取知识库失败。")); });
    return () => controller.abort();
  }, [connection, accountId, revision]);

  // 本机语义模型：没下过先问用户；下好了就加载进 Worker，把还没向量的段算完。离开这一页就停，下次接着算
  useEffect(() => {
    if (!connection) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const run = async () => {
      let state = await getKnowledgeModel(connection, signal);
      while (state.status === "downloading") {
        setModel(state);
        setSemantic({ phase: "downloading", message: "" });
        await new Promise(resolve => setTimeout(resolve, 1000));
        signal.throwIfAborted();
        state = await getKnowledgeModel(connection, signal);
      }
      setModel(state);
      if (state.status === "failed") { setSemantic({ phase: "failed", message: state.message }); return; }
      if (state.status !== "ready") { setSemantic({ phase: "off", message: "" }); return; }
      setSemantic({ phase: "loading", message: "" });
      embedder.current ||= await KnowledgeEmbedder.load(connection, signal);
      for (;;) {
        const { items } = await pendingPassages(connection, accountId, signal);
        if (!items.length) break;
        setSemantic({ phase: "embedding", message: "" });
        const vectors = [];
        for (const item of items) vectors.push({ hash: item.hash, vector: await embedder.current.embed(item.text) });
        signal.throwIfAborted();
        await saveVectors(connection, accountId, vectors, signal);
        setView(await getKnowledge(connection, accountId, signal));
      }
      setSemantic({ phase: "ready", message: "" });
    };
    run().catch(cause => {
      if (signal.aborted) return;
      embedder.current?.close();
      embedder.current = null;
      setSemantic({ phase: "failed", message: message(cause, "本机语义模型没能加载，先用关键词检索。") });
    });
    return () => controller.abort();
  }, [connection, accountId, revision, semanticTry]);
  useEffect(() => () => { embedder.current?.close(); asking.current?.abort(); }, []);

  if (!connection) return <View style={styles.root}><View style={[styles.content, styles.gate]} {...ws("e-empty")}>
    <BookOpenText size={34} color={color.accent} /><Text style={styles.gateTitle}>连接采集器后使用知识库</Text>
    <Text style={kit.body}>视频解析的结果存在采集器里，连上就能检索和提问。</Text><SmallButton label="前往连接" onPress={onOpenSettings} />
  </View></View>;

  const queryVector = async (text: string) => {
    if (semantic.phase !== "ready" || !embedder.current) return null;
    try { return await embedder.current.embed(text, true); } catch { return null; }
  };
  const search = async () => {
    const text = query.trim();
    if (!text || busy) return;
    setBusy("search"); setNotice(""); setAnswer(null); setHits(null);
    try { setHits((await searchKnowledge(connection, accountId, text, await queryVector(text))).hits); }
    catch (cause) { setNotice(message(cause, "检索失败，请重试。")); }
    finally { setBusy(""); }
  };
  const ask = async () => {
    const text = query.trim();
    if (!text || busy) return;
    const config = loadAssistantConfig();
    if (!assistantConfigReady(config)) { setNotice(AI_NOTICE); return; }
    const controller = new AbortController();
    asking.current = controller;
    // 上一问的回答先清掉，这一问没检索到或出错时不会把旧回答当成这一问的
    setBusy("ask"); setNotice(""); setHits(null); setAnswer(null);
    try {
      const reply = await askKnowledge(connection, accountId, text, await queryVector(text), config, controller.signal);
      if (reply.notice) setNotice(reply.notice); else setAnswer({ ...reply, question: text });
    } catch (cause) { if (!controller.signal.aborted) setNotice(message(cause, "提问失败，请重试。")); }
    finally { if (asking.current === controller) asking.current = null; setBusy(""); }
  };

  const embedded = view ? `${view.embedded} / ${view.unique}` : "";
  const status = semantic.phase === "downloading" && model ? `正在下载本机语义模型 ${mb(model.received)} / ${mb(model.total)} MB`
    : semantic.phase === "loading" ? "正在加载本机语义模型…"
    : semantic.phase === "embedding" ? `正在计算语义向量 ${embedded} 段`
    : semantic.phase === "ready" ? "关键词 + 本机语义混合检索"
    : "";

  return <ScrollView testID="knowledge-workspace" style={styles.root} contentContainerStyle={styles.content}>
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={styles.title}>知识库</Text>
      <Text style={kit.muted}>视频解析的逐字稿、学习笔记和分镜脚本都在这里，可以检索，也可以向 AI 提问。</Text>
    </View>

    <View {...ws("e-box")} style={styles.panel}>
      {semantic.phase === "off" ? <View style={kit.between}>
        <Text style={[kit.body, { flex: 1, minWidth: 220 }]}>现在只按关键词检索。下载本机语义模型（约 {model ? mb(model.total) : "91"} MB，只下一次）后，说法不同也能找到。</Text>
        <SmallButton label="下载语义模型" onPress={() => void prepareKnowledgeModel(connection).then(() => retrySemantic(v => v + 1), cause => setSemantic({ phase: "failed", message: message(cause, "下载没能开始。") }))} />
      </View> : semantic.phase === "failed" ? <ErrorLine text={semantic.message} onRetry={() => void prepareKnowledgeModel(connection).catch(() => undefined).then(() => retrySemantic(v => v + 1))} />
        : <Text style={kit.muted}>{status}</Text>}
      <View style={styles.askRow}>
        <TextInput accessibilityLabel="检索或提问" placeholder="搜关键词，或直接问一个问题" placeholderTextColor={color.textMuted} style={styles.input}
          value={query} onChangeText={setQuery} onSubmitEditing={() => void search()} maxLength={1000} />
        <SmallButton label={busy === "search" ? "检索中…" : "检索"} disabled={!query.trim() || !!busy} onPress={() => void search()} />
        <SmallButton label={busy === "ask" ? "AI 回答中…" : "问 AI"} disabled={!query.trim() || !!busy} onPress={() => void ask()} />
        {busy === "ask" ? <SmallButton label="停止" onPress={() => asking.current?.abort()} /> : null}
      </View>
      {notice ? <View style={kit.row}><Text style={[kit.body, { flex: 1 }]}>{notice}</Text>{notice === AI_NOTICE ? <SmallButton label="去设置" onPress={onOpenAiSettings} /> : null}</View> : null}
      {answer ? <View style={{ gap: 12 }}>
        <Text style={kit.subhead}>{answer.question}</Text>
        <Markdown text={answer.answer} />
        {answer.citationWarning ? <Text style={[kit.muted, { color: color.danger }]}>{answer.citationWarning}</Text> : null}
        <Text style={kit.muted}>引用的片段</Text>
        {answer.sources.map(hit => <Passage key={hit.id} hit={hit} title={titleOf(hit)} onOpen={() => open({ videoId: hit.videoId, title: titleOf(hit) })} />)}
      </View> : null}
      {hits ? hits.length ? <View style={{ gap: 10 }}>{hits.map(hit => <Passage key={hit.id} hit={hit} title={titleOf(hit)} onOpen={() => open({ videoId: hit.videoId, title: titleOf(hit) })} />)}</View>
        : <Empty small text="没有检索到相关段落，换个说法试试。" /> : null}
    </View>

    <View style={{ gap: 4 }}>
      <View style={kit.between}>
        <Text style={kit.subhead}>收录内容{view ? `（${view.documents.length} 份 · ${view.chunks} 段）` : ""}</Text>
        <SmallButton label="刷新" onPress={() => refresh(v => v + 1)} />
      </View>
      {error ? <ErrorLine text={error} onRetry={() => refresh(v => v + 1)} />
        : !view ? <Loading label="正在读取知识库" />
        : !view.documents.length ? <Empty lines={["还没有解析内容。", "在内容库、播放器或 AI 助手里点「解析视频」，做好的逐字稿、学习笔记和分镜脚本会自动收进来。"]} />
        : view.documents.map(doc => <Pressable key={doc.id} accessibilityRole="button" accessibilityLabel={`查看解析：${titleOf(doc)}`}
            onPress={() => open({ videoId: doc.videoId, title: titleOf(doc) })} style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.surfaceMuted }]}>
            <Text style={styles.badge}>{kindLabel[doc.kind]}</Text>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={kit.body} numberOfLines={1}>{titleOf(doc)}</Text>
              <Text style={kit.muted} numberOfLines={1}>{[doc.createdAt && new Date(doc.createdAt).toLocaleString("zh-CN"), `${doc.chars} 字 · ${doc.chunks} 段`, doc.model].filter(Boolean).join(" · ")}</Text>
            </View>
            <ChevronRight size={16} color={color.textMuted} />
          </Pressable>)}
    </View>
    {opened && <VideoAnalysisDialog key={opened.videoId} connection={connection} accountId={accountId} videoId={opened.videoId} title={opened.title}
      onClose={() => { open(null); refresh(v => v + 1); }} />}
  </ScrollView>;
}

function Passage({ hit, title, onOpen }: { hit: KnowledgeHit; title: string; onOpen: () => void }) {
  const [full, setFull] = useState(false);
  return <View style={styles.passage}>
    <View style={kit.between}>
      <Text style={[kit.muted, { flex: 1 }]} numberOfLines={1}>{hit.citation ? `[${hit.citation}] ` : ""}《{title}》{hit.label}</Text>
      <Text style={styles.link} onPress={onOpen}>查看解析</Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={full ? "收起片段" : "展开片段"} onPress={() => setFull(v => !v)}
      style={Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null}>
      <Text style={kit.body} numberOfLines={full ? undefined : 4}>{hit.quote}</Text>
    </Pressable>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  content: { padding: 32, gap: 20, paddingBottom: 70, maxWidth: 980, width: "100%", alignSelf: "center" },
  gate: { alignItems: "center", gap: 14, paddingVertical: 60 },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 17, fontWeight: "600" },
  title: { color: color.text, fontFamily: font.body, fontSize: 24, fontWeight: "600" },
  panel: { gap: 14, padding: 20, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  askRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  input: { flex: 1, minWidth: 220, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: color.surfaceRaised, color: color.text, fontFamily: font.body,
    fontSize: 14, borderWidth: 1, borderRadius: radius.small, borderColor: color.borderSoft },
  passage: { gap: 6, padding: 12, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  link: { color: color.accent, fontFamily: font.body, fontSize: 12 },
  row: { minHeight: 56, paddingVertical: 9, paddingHorizontal: 4, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderColor: color.borderSoft },
  badge: { minWidth: 64, textAlign: "center", paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: "hidden",
    color: color.textSecondary, backgroundColor: alpha(color.accent, 0.12), fontFamily: font.body, fontSize: 11 },
});
