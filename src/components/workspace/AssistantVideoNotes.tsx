import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { PersonalRecordCollection, PersonalRecordType, PersonalVideoRecord } from "../../domain/personalRecords";
import type { ExploreConnection } from "../../services/explorer";
import { searchRecords } from "../../services/recordSearch";
import { analysisVideoIdOf } from "../../services/videoFeed";
import { getSavedVideoNotes, type SavedVideoNote } from "../../services/videoAnalysis";
import { Empty, ErrorLine, kit, Loading, Segmented, SmallButton, Tabs } from "./CreatorKit";
import { VideoAnalysisDialog } from "./VideoAnalysisPanel";
import { workspaceColors as color } from "./workspaceTheme";

const sources: { value: PersonalRecordType | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "watch_history", label: "观看历史" },
  { value: "liked_videos", label: "喜欢" }, { value: "favorite_videos", label: "收藏" },
];
const tabs = [{ value: "library", label: "从内容库选片" }, { value: "notes", label: "已生成笔记" }] as const;
const pageSize = 30;
type Selection = { videoId: string; title: string; key?: string };
type Props = { connection: ExploreConnection; accountId: string; records: PersonalRecordCollection; onClose: () => void };

export function AssistantVideoNotes({ connection, accountId, records, onClose }: Props) {
  const [tab, setTab] = useState<typeof tabs[number]["value"]>("library");
  const [source, setSource] = useState<PersonalRecordType | "all">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selection, select] = useState<Selection | null>(null);
  const [notes, setNotes] = useState<SavedVideoNote[] | null>(null);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const { baseUrl, token } = connection;
  useEffect(() => {
    if (tab !== "notes" || selection) return;
    const controller = new AbortController();
    setNotes(null); setError("");
    getSavedVideoNotes({ baseUrl, token }, controller.signal, accountId).then(items => {
      if (!controller.signal.aborted) setNotes(items);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取笔记失败。");
    });
    return () => controller.abort();
  }, [baseUrl, token, accountId, revision, tab, selection]);

  const byId = useMemo(() => {
    const index = new Map<string, PersonalVideoRecord>();
    for (const list of Object.values(records)) for (const record of list) {
      const id = analysisVideoIdOf(record);
      if (id && !index.has(id)) index.set(id, record);
    }
    return index;
  }, [records]);
  const videos = useMemo(() => {
    if (tab !== "library") return [];
    if (source === "all") return searchRecords(Array.from(byId.values()), query);
    const seen = new Set<string>();
    return searchRecords(records[source], query).filter(record => {
      const id = analysisVideoIdOf(record);
      if (!id || seen.has(id)) return false;
      seen.add(id); return true;
    });
  }, [records, byId, source, query, tab]);
  const noteTitle = (note: SavedVideoNote) => note.title || byId.get(note.videoId)?.title || `视频 ${note.videoId}`;
  const filteredNotes = (notes ?? []).filter(note => `${noteTitle(note)} ${byId.get(note.videoId)?.title ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const count = tab === "library" ? videos.length : filteredNotes.length;
  const pages = Math.ceil(count / pageSize);
  const current = Math.min(page, Math.max(0, pages - 1));
  const start = current * pageSize;
  const rows = tab === "library"
    ? videos.slice(start, start + pageSize).map(record => ({
        videoId: analysisVideoIdOf(record)!, key: undefined, title: record.title || "未命名视频", detail: record.author ?? "",
      }))
    : filteredNotes.slice(start, start + pageSize).map(note => ({
        videoId: note.videoId, key: note.key, title: noteTitle(note),
        detail: [new Date(note.createdAt).toLocaleString("zh-CN"), note.withFrames ? "结合画面" : "仅口播", note.engine === "qwen" ? "Qwen3-ASR" : "必剪", note.model].filter(Boolean).join(" · "),
      }));

  return <View style={styles.root}>
    <View style={kit.between}><Text accessibilityRole="header" style={styles.heading}>视频解析</Text><SmallButton label="返回对话" onPress={onClose} /></View>
    <Tabs options={[...tabs]} value={tab} onChange={next => { setTab(next); setQuery(""); setPage(0); }} />
    <View style={kit.between}>
      {tab === "library" ? <Segmented small options={sources} value={source} onChange={next => { setSource(next); setPage(0); }} />
        : <SmallButton label="刷新笔记" onPress={() => refresh(v => v + 1)} />}
      <TextInput accessibilityLabel={tab === "library" ? "搜索内容库视频" : "搜索已生成笔记"} placeholder={tab === "library" ? "搜标题、作者或话题" : "搜笔记或视频标题"}
        placeholderTextColor={color.textMuted} style={styles.search} value={query} onChangeText={v => { setQuery(v); setPage(0); }} />
    </View>
    {tab === "notes" && error ? <ErrorLine text={error} onRetry={() => refresh(v => v + 1)} />
      : tab === "notes" && !notes ? <Loading label="正在读取已生成笔记" />
      : !count ? <Empty text={query ? "没有找到匹配的结果" : tab === "library" ? "这里还没有可解析的视频" : "还没有学习笔记，先从内容库选一条视频。"} />
      : <ScrollView key={`${tab}-${source}-${current}`} style={{ flex: 1 }}>{rows.map(row =>
          <Pressable key={row.videoId + (row.key ?? "")} accessibilityRole="button" accessibilityLabel={`${row.key ? "查看笔记" : "选择视频"}：${row.title}`}
            onPress={() => select({ videoId: row.videoId, key: row.key, title: byId.get(row.videoId)?.title || row.title })}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.surfaceMuted }]}>
            <View style={{ flex: 1, gap: 3 }}><Text style={kit.body} numberOfLines={2}>{row.title}</Text>
              {row.detail ? <Text style={kit.muted} numberOfLines={1}>{row.detail}</Text> : null}</View>
            <ChevronRight size={16} color={color.textMuted} />
          </Pressable>)}</ScrollView>}
    {pages > 1 ? <View style={kit.row}><SmallButton label="上一页" disabled={!current} onPress={() => setPage(current - 1)} />
      <Text style={kit.muted}>{current + 1} / {pages}</Text><SmallButton label="下一页" disabled={current + 1 >= pages} onPress={() => setPage(current + 1)} /></View> : null}
    {selection && <VideoAnalysisDialog key={selection.videoId + (selection.key ?? "")} connection={connection} accountId={accountId}
      videoId={selection.videoId} title={selection.title} initialNotes={{ key: selection.key }} onClose={() => select(null)} />}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, padding: 20, gap: 14 },
  heading: { color: color.text, fontSize: 21, fontWeight: "600" },
  search: { minWidth: 180, flexGrow: 1, maxWidth: 340, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: color.surface, color: color.text, borderWidth: 1, borderRadius: 8, borderColor: color.borderSoft },
  row: { minHeight: 54, paddingVertical: 9, paddingHorizontal: 4, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderColor: color.borderSoft },
});
