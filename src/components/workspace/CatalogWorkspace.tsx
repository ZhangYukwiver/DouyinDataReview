import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { ExploreConnection } from "../../services/explorer";
import { assistantConfigReady, isLocalAiRuntime, loadAssistantConfig } from "../../services/assistant";
import { accountChoiceLabel, accountLabel, loadLibraryFilter, platformLabels, saveLibraryFilter, signalLabels, workspaceRequest,
  type ContentPlatform, type LibraryAnswer, type LibraryFilter, type LibraryItem, type LibrarySignal, type LibraryTopic, type PlatformDirectory } from "../../services/contentWorkspace";
import { Empty, ErrorLine, kit, Loading, Panel, SmallButton, Tabs } from "./CreatorKit";
import { ConnectLibrary, contentStyles as style, SearchField, useWorkspaceRead } from "./ContentWorkspaceControls";
import { workspaceColors as color } from "./workspaceTheme";

type Page = "catalog" | "topics" | "knowledge";
type Props = { page: Page; connection: ExploreConnection | null; accounts?: PlatformDirectory; onConnect: () => void;
  onOpen: (url: string) => Promise<void>; onAiSettings: () => void; biliEnabled: boolean; revision: number; askRequest: number };
const api = "/v1/library";
const pageSize = 40;
const allSignals = [{ label: "全部记录", value: "" }, ...Object.entries(signalLabels).map(([value, label]) => ({ value, label }))];

export function CatalogWorkspace({ page, connection, accounts, onConnect, onOpen, onAiSettings, biliEnabled, revision, askRequest }: Props) {
  const [filter, setFilter] = useState<LibraryFilter>(loadLibraryFilter);
  const [signal, setSignal] = useState("");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [topicId, setTopic] = useState("");
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [nonce, refresh] = useState(0);
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(page === "knowledge");
  const scroll = useRef<ScrollView>(null);
  const previousRequest = useRef(askRequest);
  useEffect(() => {
    if (previousRequest.current === askRequest) return;
    previousRequest.current = askRequest;
    if (page === "topics" && !topicId) { setActionError("先选择一个专题，再向其中的资料提问。"); return; }
    setAsking(true);
    const frame = requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    return () => cancelAnimationFrame(frame);
  }, [askRequest, page, topicId]);
  const topics = useWorkspaceRead<{ topics: LibraryTopic[] }>(connection, api + "/topics", nonce + revision);
  const chosenTopic = topics?.value?.topics.find(t => t.id === topicId);
  const libraryFilter = page === "topics" ? { platform: "", accountId: "" } : filter;
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (libraryFilter.platform) params.set("platform", libraryFilter.platform);
  if (libraryFilter.accountId) params.set("accountId", libraryFilter.accountId);
  if (topicId) params.set("topicId", topicId);
  if (signal) params.set("signal", signal);
  if (query) params.set("query", query);
  const index = useWorkspaceRead<{ items: LibraryItem[]; total: number }>(connection,
    selected || (page === "topics" && !topicId) ? null : api + "?" + params, nonce + revision);
  const detail = useWorkspaceRead<{ item: LibraryItem }>(connection, selected ? api + "/items/" + encodeURIComponent(selected) + "?" + params : null, nonce + revision);
  const item = detail?.value?.item;
  useEffect(() => {
    if (accounts && filter.platform && filter.accountId && !accounts[filter.platform].accounts.some(a => a.id === filter.accountId)) {
      const next = { platform: filter.platform, accountId: "" };
      setFilter(next); saveLibraryFilter(next); setOffset(0);
    }
  }, [accounts, filter]);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(text.trim()); setOffset(0); }, 220);
    return () => clearTimeout(timer);
  }, [text]);
  const changeFilter = (next: LibraryFilter) => { setFilter(next); saveLibraryFilter(next); setOffset(0); setSelected(""); };
  const chooseTopic = (id: string) => { setTopic(id); setSelected(""); setText(""); setQuery(""); setOffset(0); setActionError(""); };
  const mutate = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setActionError("");
    try { await operation(); refresh(v => v + 1); }
    catch (error) { setActionError(error instanceof Error ? error.message : "保存失败。"); }
    finally { setBusy(false); }
  };
  if (!connection) return <ConnectLibrary onConnect={onConnect} />;
  const platformOptions = (Object.keys(platformLabels) as ContentPlatform[]).filter(p => p !== "bilibili" || biliEnabled || accounts?.bilibili?.accounts.some(a => a.lastSyncedAt));
  const filteredAccounts = filter.platform && accounts?.[filter.platform]?.accounts;
  const toggleMember = (topic: LibraryTopic, key: string) => mutate(async () => {
    const path = api + "/topics/" + encodeURIComponent(topic.id) + "/items";
    await workspaceRequest(connection, path, { method: topic.items.includes(key) ? "DELETE" : "POST", body: { key } });
  });
  const createTopic = () => mutate(async () => {
    const result = await workspaceRequest<{ topic: LibraryTopic }>(connection, api + "/topics", { body: { name: name.trim() } });
    setName("");
    if (selected) await workspaceRequest(connection, api + "/topics/" + result.topic.id + "/items", { body: { key: selected } });
    else chooseTopic(result.topic.id);
  });
  const scopeAccount = filteredAccounts && filteredAccounts.find(a => a.id === libraryFilter.accountId);
  const scopeLabel = [selected ? item?.title || "当前内容" : chosenTopic?.name,
    libraryFilter.platform && platformLabels[libraryFilter.platform as ContentPlatform], scopeAccount && accountChoiceLabel(scopeAccount, filteredAccounts || []),
    !selected && signalLabels[signal as LibrarySignal], !selected && query && "搜索「" + query + "」"].filter(Boolean).join(" · ") || "全部内容";
  return <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={style.page} keyboardShouldPersistTaps="handled">
    {page === "topics" && !selected && <>
      <Panel title="本地专题">
        <View style={kit.row}><SearchField label="专题名称" placeholder="输入新专题名称" value={name} onChange={setName} onSubmit={name.trim() ? createTopic : undefined} />
          <SmallButton label="新建专题" disabled={busy || !name.trim()} onPress={createTopic} /></View>
        {topics?.value?.topics.length ? <Tabs value={topicId} options={topics.value.topics.map(t => ({ label: t.name + " · " + t.items.length, value: t.id }))} onChange={chooseTopic} />
          : topics?.value && <Empty small text="创建一个专题后，可以从内容库加入不同平台的资料。" />}
      </Panel>
    </>}
    {page !== "topics" && !selected && <Panel title={page === "knowledge" ? "检索资料" : "查找内容"}>
      <Tabs value={filter.platform} onChange={p => changeFilter({ platform: p as ContentPlatform | "", accountId: "" })}
        options={[{ value: "", label: "全部平台" }, ...platformOptions.map(value => ({ value, label: platformLabels[value] }))]} />
      {filteredAccounts && <Tabs value={filter.accountId} onChange={accountId => changeFilter({ ...filter, accountId })}
        options={[{ value: "", label: "全部账号" }, ...filteredAccounts.map(a => ({ value: a.id, label: accountChoiceLabel(a, filteredAccounts) }))]} />}
      {page === "catalog" && <Tabs value={signal} options={allSignals} onChange={s => { setSignal(s); setOffset(0); }} />}
      {page === "knowledge" && Boolean(topics?.value?.topics.length) && <Tabs value={topicId} onChange={chooseTopic}
        options={[{ value: "", label: "全部专题与资料" }, ...(topics?.value?.topics ?? []).map(t => ({ value: t.id, label: t.name }))]} />}
      <SearchField label="搜索内容" placeholder="搜索标题、作者、正文或逐字稿" value={text} onChange={setText} />
    </Panel>}
    {(detail?.error || index?.error || topics?.error || actionError) && <ErrorLine text={actionError || detail?.error || index?.error || topics?.error || ""} onRetry={() => { setActionError(""); refresh(v => v + 1); }} />}
    {selected ? <>
      <View style={kit.row}><SmallButton label="返回列表" onPress={() => { setSelected(""); setActionError(""); }} /></View>
      {item ? <Panel title={item.title || "未命名内容"} subtitle={platformLabels[item.platform]}>
        <Text style={kit.muted}>{[item.author, ...item.sourceAccounts.map(a => accounts?.[item.platform]?.accounts.find(v => v.id === a.accountId)).filter(a => !!a).map(accountLabel)].filter(Boolean).join(" · ")}</Text>
        {item.body && <Text selectable style={kit.body}>{item.body}</Text>}
        {item.materials?.map((material, i) => <View key={i} style={{ gap: 6 }}><Text style={kit.subhead}>{material.title || ({ transcript: "逐字稿", notes: "学习笔记", script: "分镜脚本" }[material.kind] ?? material.kind)}</Text><Text selectable style={kit.body}>{material.text}</Text></View>)}
        <View style={kit.row}>{item.url && <SmallButton label="打开原内容" onPress={() => void onOpen(item.url!)} />}</View>
        <Text style={style.label}>整理到专题</Text>
        <View style={kit.row}>{topics?.value?.topics.map(t => <SmallButton key={t.id} done={t.items.includes(item.key)} disabled={busy}
          label={(t.items.includes(item.key) ? "移出「" : "加入「") + t.name + "」"} onPress={() => void toggleMember(t, item.key)} />)}</View>
        <View style={kit.row}><SearchField label="新专题名称" value={name} onChange={setName} />
          <SmallButton label="新建并加入" disabled={busy || !name.trim()} onPress={createTopic} /></View>
      </Panel> : !detail?.error && <Loading label="正在读取内容" />}
    </> : (page !== "topics" || topicId) && <Panel title={chosenTopic?.name ?? (page === "knowledge" ? "资料" : "内容")} subtitle={index?.value ? index.value.total + " 条" : undefined}
      extra={<SmallButton label="刷新" onPress={() => refresh(v => v + 1)} />}>
      {page === "topics" && <SearchField label="在专题内搜索" value={text} onChange={setText} />}
      {!index ? <Loading label="正在读取本地内容" /> : index.value?.items.length ? index.value.items.map(entry =>
        <Pressable key={entry.key} accessibilityRole="button" accessibilityLabel={entry.title || entry.contentId} style={style.entry}
          onPress={() => { setSelected(entry.key); setActionError(""); }}>
          <View style={{ flex: 1, gap: 4 }}><Text numberOfLines={2} style={style.title}>{entry.title || entry.contentId}</Text>
            <Text style={kit.muted}>{[platformLabels[entry.platform], entry.author,
              ...new Set(entry.sourceAccounts.flatMap(a => a.signals.map(s => signalLabels[s as LibrarySignal] || (s === "manual" ? "手动保存" : s))))].filter(Boolean).join(" · ")}</Text></View>
          <ChevronRight size={16} color={color.textMuted} />
        </Pressable>) : index.value && <Empty small text={query || signal || filter.platform ? "当前筛选下没有内容。" : topicId ? "在内容详情中选择「加入专题」，资料就会出现在这里。" : "同步平台收藏或手动保存内容后，可在这里查找。"} />}
      {(offset > 0 || (index?.value?.total ?? 0) > pageSize) && <View style={kit.row}>
        <SmallButton label="上一页" disabled={!offset} onPress={() => setOffset(v => Math.max(0, v - pageSize))} />
        <Text style={kit.muted}>第 {1 + offset / pageSize} 页</Text>
        <SmallButton label="下一页" disabled={!index?.value || offset + pageSize >= index.value.total} onPress={() => setOffset(v => v + pageSize)} /></View>}
    </Panel>}
    {(page !== "topics" || topicId) && <>
      <View style={kit.row}><SmallButton label={asking ? "收起资料问答" : "用 AI 问这些资料"} onPress={() => setAsking(!asking)} /></View>
      {asking && <ScopedQuestion key={JSON.stringify([selected, topicId, libraryFilter, signal, query])} connection={connection} label={scopeLabel}
        scope={{ scope: selected ? "item" : topicId ? "topic" : "library", topicId: topicId || undefined, key: selected || undefined,
          platform: libraryFilter.platform || undefined, accountId: libraryFilter.accountId || undefined,
          signal: !selected && signal || undefined, filterQuery: !selected && query || undefined }}
        onOpenItem={setSelected} onAiSettings={onAiSettings} />}
    </>}
  </ScrollView>;
}

function ScopedQuestion({ connection, label, scope, onOpenItem, onAiSettings }: { connection: ExploreConnection; label: string;
  scope: object; onOpenItem: (key: string) => void; onAiSettings: () => void }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<LibraryAnswer>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const ask = async () => {
    if (!question.trim() || busy) return;
    const config = loadAssistantConfig();
    if (!assistantConfigReady(config)) { onAiSettings(); return; }
    const current = new AbortController();
    controller.current = current; setBusy(true); setError(""); setResult(undefined);
    try {
      const value = await workspaceRequest<LibraryAnswer>(connection, api + "/ask", { signal: current.signal, body: {
        ...scope, question: question.trim(), config: isLocalAiRuntime(config.runtime) ? { runtime: config.runtime, model: config.model } : config } });
      if (!current.signal.aborted) setResult(value);
    } catch (e) { if (!current.signal.aborted) setError(e instanceof Error ? e.message : "问答失败。"); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return <Panel title="资料问答" subtitle={"范围 · " + label}>
    <View style={kit.row}><SearchField label="向这些资料提问" value={question} onChange={setQuestion} onSubmit={ask} />
      <SmallButton label={busy ? "正在查阅…" : "提问"} disabled={busy || !question.trim()} onPress={ask} /></View>
    {error && <ErrorLine text={error} />}
    {result && <><Text style={kit.body} selectable>{result.answer}</Text><View style={kit.row}>{result.sources.map(s =>
      <SmallButton key={s.citation} label={s.citation + " · " + platformLabels[s.platform] + " · " + s.title} onPress={() => onOpenItem(s.entryKey)} />)}</View></>}
  </Panel>;
}
