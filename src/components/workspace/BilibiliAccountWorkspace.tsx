import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LockKeyhole, MessageCircle, RefreshCw, Send, UserRound } from "lucide-react-native";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ExploreConnection } from "../../services/explorer";
import { callBilibiliProtocol, type BilibiliProtocolInputs } from "../../services/bilibili";
import { contentStyles, SearchField } from "./ContentWorkspaceControls";
import { Empty, ErrorLine, ExportButton, kit, Loading, MetricTile, Panel, SmallButton, Tabs } from "./CreatorKit";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

type JsonRecord = Record<string, unknown>;
type WorkspaceProps = {
  connection: ExploreConnection | null;
  accountId: string;
  onOpenSettings: () => void;
  onManageAccount?: () => void;
  privateMode?: boolean;
};

type ChatSession = JsonRecord;
type ChatMessage = JsonRecord;
type CreatorPanel = "overview" | "audience" | "fans" | "trend" | "videos" | "video";
type TrendMetric = NonNullable<Extract<BilibiliProtocolInputs["creator/data"], { panel: "trend" }>['metric']>;

const TREND_METRICS: Array<{ label: string; value: TrendMetric }> = [
  { label: "播放", value: "play" },
  { label: "弹幕", value: "danmaku" },
  { label: "评论", value: "comment" },
  { label: "分享", value: "share" },
  { label: "硬币", value: "coin" },
  { label: "收藏", value: "favorite" },
  { label: "充电", value: "charge" },
  { label: "点赞", value: "like" },
];

const KEY_LABELS: Record<string, string> = {
  archive: "投稿数",
  archives: "投稿",
  aid: "AV 号",
  article: "专栏",
  bvid: "BVID",
  charge: "充电",
  coin: "硬币",
  comment: "评论",
  comments: "评论",
  danmaku: "弹幕",
  favorite: "收藏",
  fans: "粉丝",
  follower: "粉丝",
  following: "关注",
  like: "点赞",
  likes: "点赞",
  play: "播放",
  plays: "播放",
  pubdate: "发布时间",
  share: "分享",
  title: "标题",
  view: "播放",
  views: "播放",
  video: "视频",
};

const isRecord = (value: unknown): value is JsonRecord => Boolean(value && typeof value === "object" && !Array.isArray(value));

function recordValue(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function idValue(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return textValue(value);
}

function arrayValue(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const candidates: unknown[] = [value];
  if (isRecord(value)) {
    for (const key of keys) candidates.push(value[key]);
    candidates.push(value.data, value.result);
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) {
      for (const key of keys) if (Array.isArray(candidate[key])) return candidate[key] as unknown[];
    }
  }
  return [];
}

function cursorValue(value: unknown, keys: string[]): string | undefined {
  const candidate = recordValue(value, keys);
  if (isRecord(candidate)) {
    return cursorValue(candidate, ["next", "value", "cursor", "min_seqno", "end_seqno", "end_ts", "next_ts"]);
  }
  const cursor = idValue(candidate);
  return cursor && cursor !== "0" ? cursor : undefined;
}

function hasMoreValue(value: unknown): boolean {
  const candidate = recordValue(value, ["has_more", "hasMore", "has_next", "hasNext"]);
  return candidate === true || candidate === 1 || candidate === "1" || candidate === "true";
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function sessionUid(session: ChatSession): string {
  return idValue(recordValue(session, ["talker_id", "talkerId", "uid", "mid", "user_id"]));
}

function sessionInfo(session: ChatSession): JsonRecord {
  const info = recordValue(session, ["account_info", "accountInfo", "user", "talker"]);
  return isRecord(info) ? info : {};
}

function sessionName(session: ChatSession): string {
  const info = sessionInfo(session);
  return textValue(recordValue(session, ["uname", "name", "nickname", "nick_name"]))
    || textValue(recordValue(info, ["uname", "name", "nickname", "nick_name"]))
    || sessionUid(session)
    || "未命名会话";
}

function messageType(message: ChatMessage): number | undefined {
  const value = Number(recordValue(message, ["msg_type", "msgType", "message_type", "messageType"]));
  return Number.isFinite(value) ? value : undefined;
}

function decodeTextPayload(raw: unknown): string {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return "";
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") return parsed.trim();
      if (isRecord(parsed)) {
        const text = recordValue(parsed, ["content", "text"]);
        return typeof text === "string" ? text.trim() : "";
      }
      return "";
    } catch {
      return value;
    }
  }
  if (isRecord(raw)) {
    const text = recordValue(raw, ["content", "text"]);
    return typeof text === "string" ? text.trim() : "";
  }
  return typeof raw === "number" || typeof raw === "boolean" ? textValue(raw) : "";
}

function messageText(message: ChatMessage): string {
  const raw = recordValue(message, ["content", "text", "message", "msg"]);
  const type = messageType(message);
  if (type !== undefined && type !== 1) return type >= 100000 ? "[系统消息]" : "[非文本消息]";
  return decodeTextPayload(raw) || "[非文本消息]";
}

function messageSender(message: ChatMessage): string {
  return idValue(recordValue(message, ["sender_uid", "senderUid", "sender_id", "uid", "mid"]));
}

function messageTime(message: ChatMessage): number {
  const raw = recordValue(message, ["timestamp", "time", "created_at", "create_time"]);
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric / 1000 : numeric;
  const parsed = Date.parse(textValue(raw));
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function messageKey(message: ChatMessage, index: number): string {
  return idValue(recordValue(message, ["msg_seqno", "msgSeqno", "seqno", "id", "msg_key"]))
    || `${messageSender(message)}-${messageTime(message)}-${index}`;
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const all = [...current, ...incoming];
  const unique = new Map<string, ChatMessage>();
  all.forEach((item, index) => unique.set(messageKey(item, index), item));
  return [...unique.values()].sort((left, right) => messageTime(left) - messageTime(right));
}

function mergeSessions(current: ChatSession[], incoming: ChatSession[]): ChatSession[] {
  const all = [...current, ...incoming];
  const unique = new Map<string, ChatSession>();
  all.forEach((item, index) => unique.set(sessionUid(item) || `session-${index}`, item));
  return [...unique.values()];
}

function decimalId(value: unknown): string | undefined {
  const text = idValue(value);
  if (!/^\d+$/u.test(text)) return undefined;
  return text.replace(/^0+(?=\d)/u, "");
}

function compareDecimalIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function minimumMessageSeqno(messages: ChatMessage[]): string | undefined {
  let minimum: string | undefined;
  for (const message of messages) {
    const seqno = decimalId(recordValue(message, ["msg_seqno", "msgSeqno"]));
    if (seqno && (!minimum || compareDecimalIds(seqno, minimum) < 0)) minimum = seqno;
  }
  return minimum;
}

function nextCursor(value: string | undefined, before?: string): string | undefined {
  if (!value || value === "0" || value === before) return undefined;
  const normalizedValue = decimalId(value);
  const normalizedBefore = decimalId(before);
  if (normalizedValue && normalizedBefore && normalizedValue === normalizedBefore) return undefined;
  return value;
}

function sessionPageCursor(payload: unknown, sessions: ChatSession[], before?: string): string | undefined {
  const explicit = cursorValue(payload, ["next_cursor", "next_ts", "cursor", "end_ts", "next"]);
  const last = sessions[sessions.length - 1];
  const fallback = idValue(recordValue(last, ["session_ts"]));
  return nextCursor(explicit ?? fallback, before);
}

function messagePageCursor(payload: unknown, messages: ChatMessage[], before?: string): string | undefined {
  const explicit = cursorValue(payload, ["next_cursor", "cursor", "min_seqno", "end_seqno", "next"]);
  return nextCursor(explicit ?? minimumMessageSeqno(messages), before);
}

function displayNumber(value: unknown): string {
  const numeric = Number(value);
  if (value !== "" && Number.isFinite(numeric)) return numeric.toLocaleString("zh-CN");
  return textValue(value) || "—";
}

function labelForKey(key: string): string {
  const plain = key.replace(/^(data|stat|result)[._]/u, "").replace(/_/gu, " ");
  return (KEY_LABELS[key] ?? KEY_LABELS[plain] ?? plain) || "数据";
}

function scalarEntries(value: unknown, prefix = "", depth = 0): Array<[string, string]> {
  if (depth > 2) return [];
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      return prefix ? [[prefix, value.map(item => textValue(item)).filter(Boolean).join("、") || "—"]] : [];
    }
    return [];
  }
  if (!isRecord(value)) return prefix && value !== null && value !== undefined ? [[prefix, textValue(value) || "—"]] : [];
  const rows: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      rows.push([next, typeof item === "number" ? displayNumber(item) : textValue(item) || "—"]);
    } else if (Array.isArray(item) && item.every(entry => entry === null || typeof entry !== "object")) {
      rows.push([next, `${item.length} 项`]);
    } else if (isRecord(item) && depth < 2) {
      rows.push(...scalarEntries(item, next, depth + 1));
    }
  }
  return rows;
}

function recordSections(value: unknown, path = "数据", depth = 0): Array<{ label: string; rows: JsonRecord[] }> {
  if (depth > 2) return [];
  if (Array.isArray(value)) {
    const rows = value.filter(isRecord);
    return rows.length ? [{ label: path, rows }] : [];
  }
  if (!isRecord(value)) return [];
  const sections: Array<{ label: string; rows: JsonRecord[] }> = [];
  for (const [key, item] of Object.entries(value)) {
    const next = labelForKey(key);
    if (Array.isArray(item)) {
      const rows = item.filter(isRecord);
      if (rows.length) sections.push({ label: next, rows });
    } else if (isRecord(item)) {
      sections.push(...recordSections(item, next, depth + 1));
    }
  }
  return sections;
}

function videoId(row: JsonRecord): string {
  const value = textValue(recordValue(row, ["bvid", "bvids", "video_id", "videoId"]));
  return /^BV[0-9A-Za-z]{10}$/u.test(value) ? value : "";
}

function rowTitle(row: JsonRecord, index: number): string {
  return textValue(recordValue(row, ["title", "arc_title", "name", "arc_name", "video_name", "archive_name", "label"]))
    || videoId(row)
    || `记录 ${index + 1}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function creatorExportRows(panel: CreatorPanel, payload: unknown): unknown[][] {
  const sections = recordSections(payload);
  const rows = sections.flatMap(section => section.rows);
  if (rows.length) {
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 16);
    return [keys.map(labelForKey), ...rows.map(row => keys.map(key => csvCell(row[key])))];
  }
  return [["维度", "数值"], ...scalarEntries(payload).map(([key, value]) => [labelForKey(key.split(".").pop() ?? key), value]), ["面板", panel]];
}

function PrivacyGate({ title, onOpenSettings }: { title: string; onOpenSettings: () => void }) {
  return <View style={styles.gate}>
    <LockKeyhole size={34} color={color.accent} />
    <Text style={styles.gateTitle}>{title}</Text>
    <Text style={kit.body}>隐私模式开启时，不读取或展示账号私信和创作者数据。</Text>
    <SmallButton label="打开设置" onPress={onOpenSettings} />
  </View>;
}

function ConnectionGate({ title, onOpenSettings }: { title: string; onOpenSettings: () => void }) {
  return <View style={styles.gate}>
    <UserRound size={34} color={color.accent} />
    <Text style={styles.gateTitle}>{title}</Text>
    <Text style={kit.body}>连接本机采集器后，读取当前 B 站账号的数据。</Text>
    <SmallButton label="前往连接" onPress={onOpenSettings} />
  </View>;
}

function ChatComposer({ draft, sending, onChange, onSend }: { draft: string; sending: boolean; onChange: (value: string) => void; onSend: () => void }) {
  return <View style={styles.composer}>
    <TextInput
      accessibilityLabel="私信内容"
      value={draft}
      onChangeText={onChange}
      onSubmitEditing={onSend}
      placeholder="输入纯文本私信"
      placeholderTextColor={color.textMuted}
      maxLength={500}
      multiline
      style={[contentStyles.input, styles.composerInput]}
    />
    <SmallButton
      label={sending ? "发送中…" : "发送私信"}
      disabled={sending || !draft.trim()}
      onPress={onSend}
    >
      <Send size={14} color={color.text} />
    </SmallButton>
  </View>;
}

function SessionRow({ session, index, selected, onPress }: { session: ChatSession; index: number; selected: boolean; onPress: () => void }) {
  const uid = sessionUid(session);
  const last = recordValue(session, ["last_msg", "lastMsg"]);
  const unread = Number(recordValue(session, ["unread_count", "unreadCount"]) ?? 0);
  return <Pressable
    key={`${uid}-${index}`}
    accessibilityRole="button"
    accessibilityState={{ selected }}
    testID="bilibili-chat-session"
    onPress={onPress}
    style={[styles.sessionRow, selected && styles.sessionSelected]}
  >
    <View style={styles.avatar}><MessageCircle size={16} color={color.accent} /></View>
    <View style={styles.sessionBody}>
      <Text numberOfLines={1} style={styles.sessionName}>{sessionName(session)}</Text>
      <Text numberOfLines={1} style={kit.muted}>{messageText(isRecord(last) ? last : {})}</Text>
    </View>
    {unread > 0 ? <Text style={styles.unread}>{displayNumber(unread)}</Text> : null}
  </Pressable>;
}

function MessageList({
  selectedUid,
  messages,
  messageHasMore,
  messageCursor,
  messagesLoading,
  draft,
  sending,
  onLoadMore,
  onDraftChange,
  onSend,
}: {
  selectedUid: string;
  messages: ChatMessage[];
  messageHasMore: boolean;
  messageCursor?: string;
  messagesLoading: boolean;
  draft: string;
  sending: boolean;
  onLoadMore: () => void;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}) {
  if (messagesLoading && !messages.length) return <Loading label="正在读取消息…" />;
  if (!messages.length) return <View style={{ gap: 12 }}><Empty text="这个会话没有可显示的文本消息。" /><ChatComposer draft={draft} sending={sending} onChange={onDraftChange} onSend={onSend} /></View>;
  return <View style={{ gap: 10 }}>
    {messageHasMore && messageCursor ? <SmallButton label="加载更早消息" disabled={messagesLoading} onPress={onLoadMore} /> : null}
    {messages.map((message, index) => {
      const outgoing = messageSender(message) !== selectedUid;
      return <View key={messageKey(message, index)} style={[styles.messageRow, outgoing && styles.messageOutgoing]}>
        <Text style={[styles.messageBubble, outgoing && styles.messageBubbleOutgoing]} selectable>{messageText(message)}</Text>
      </View>;
    })}
    <ChatComposer draft={draft} sending={sending} onChange={onDraftChange} onSend={onSend} />
  </View>;
}

export function BilibiliChatWorkspace({ connection, accountId, onOpenSettings, onManageAccount, privateMode = false }: WorkspaceProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedUid, setSelectedUid] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [messageCursor, setMessageCursor] = useState<string>();
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const sessionAbort = useRef<AbortController | null>(null);
  const messageAbort = useRef<AbortController | null>(null);
  const sendAbort = useRef<AbortController | null>(null);

  const loadSessions = useCallback(async (append = false, before?: string) => {
    if (!connection || privateMode) return;
    sessionAbort.current?.abort();
    const controller = new AbortController();
    sessionAbort.current = controller;
    setSessionsLoading(true);
    try {
      const result = await callBilibiliProtocol(connection, accountId, "dm/sessions", before ? { before } : {}, controller.signal);
      if (controller.signal.aborted) return;
      const payload = result.data;
      const next = arrayValue(payload, ["session_list", "sessions", "items", "list"])
        .filter(isRecord) as ChatSession[];
      const more = hasMoreValue(payload);
      const pageCursor = more ? sessionPageCursor(payload, next, before) : undefined;
      setSessions(current => append ? mergeSessions(current, next) : next);
      setSessionCursor(pageCursor);
      setSessionHasMore(Boolean(pageCursor));
      setError("");
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause, "读取 B 站私信会话失败。"));
    } finally {
      if (!controller.signal.aborted) setSessionsLoading(false);
    }
  }, [accountId, connection, privateMode]);

  const loadMessages = useCallback(async (uid: string, before?: string, append = false) => {
    if (!connection || privateMode || !uid) return;
    messageAbort.current?.abort();
    const controller = new AbortController();
    messageAbort.current = controller;
    setMessagesLoading(true);
    try {
      const input = before ? { uid, before, pageSize: 20 } : { uid, pageSize: 20 };
      const result = await callBilibiliProtocol(connection, accountId, "dm/messages", input, controller.signal);
      if (controller.signal.aborted) return;
      const payload = result.data;
      const next = arrayValue(payload, ["messages", "msg_list", "session_messages", "items", "list"])
        .filter(isRecord) as ChatMessage[];
      const more = hasMoreValue(payload);
      const pageCursor = more ? messagePageCursor(payload, next, before) : undefined;
      setMessages(current => append ? mergeMessages(current, next) : mergeMessages([], next));
      setMessageCursor(pageCursor);
      setMessageHasMore(Boolean(pageCursor));
      setError("");
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause, "读取 B 站私信消息失败。"));
    } finally {
      if (!controller.signal.aborted) setMessagesLoading(false);
    }
  }, [accountId, connection, privateMode]);

  useEffect(() => {
    sessionAbort.current?.abort();
    messageAbort.current?.abort();
    sendAbort.current?.abort();
    setSessions([]);
    setMessages([]);
    setSelectedUid("");
    setSessionCursor(undefined);
    setMessageCursor(undefined);
    setSessionHasMore(false);
    setMessageHasMore(false);
    setError("");
    if (connection && !privateMode) void loadSessions();
    return () => {
      sessionAbort.current?.abort();
      messageAbort.current?.abort();
      sendAbort.current?.abort();
    };
  }, [accountId, connection, loadSessions, privateMode]);

  useEffect(() => {
    if (selectedUid || !sessions.length) return;
    const uid = sessionUid(sessions[0]!);
    if (uid) {
      setSelectedUid(uid);
      void loadMessages(uid);
    }
  }, [loadMessages, selectedUid, sessions]);

  const selectedSession = useMemo(() => sessions.find(session => sessionUid(session) === selectedUid) ?? null, [selectedUid, sessions]);

  const chooseSession = (uid: string) => {
    if (!uid || uid === selectedUid) return;
    messageAbort.current?.abort();
    setSelectedUid(uid);
    setMessages([]);
    setMessageCursor(undefined);
    setMessageHasMore(false);
    setError("");
    void loadMessages(uid);
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!connection || privateMode || !selectedUid || !text || sending) return;
    sendAbort.current?.abort();
    const controller = new AbortController();
    sendAbort.current = controller;
    setSending(true);
    setError("");
    try {
      await callBilibiliProtocol(connection, accountId, "interact", { action: "message", uid: selectedUid, text }, controller.signal);
      if (controller.signal.aborted) return;
      setDraft("");
      await loadMessages(selectedUid);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause, "发送私信失败，请在 B 站原页核验。"));
    } finally {
      if (!controller.signal.aborted) setSending(false);
    }
  };

  if (privateMode) return <ScrollView style={styles.root} contentContainerStyle={styles.content}><PrivacyGate title="B 站聊天已隐藏" onOpenSettings={onOpenSettings} /></ScrollView>;
  if (!connection) return <ScrollView style={styles.root} contentContainerStyle={styles.content}><ConnectionGate title="连接采集器后查看 B 站私信" onOpenSettings={onOpenSettings} /></ScrollView>;

  return <ScrollView testID="bilibili-chat-workspace" style={styles.root} contentContainerStyle={styles.content}>
    <View style={kit.between}>
      <View style={{ gap: 5 }}>
        <Text accessibilityRole="header" style={styles.title}>B 站聊天</Text>
      </View>
      <View style={kit.row}>
        {onManageAccount ? <SmallButton label="管理账号" onPress={onManageAccount} /> : null}
        <SmallButton label="刷新" disabled={sessionsLoading} onPress={() => void loadSessions()}><RefreshCw size={14} color={color.text} /></SmallButton>
      </View>
    </View>
    {error ? <ErrorLine text={error} onRetry={() => void loadSessions()} /> : null}
    <View style={styles.chatColumns}>
      <Panel title="会话" subtitle={sessions.length ? `${sessions.length} 个会话` : undefined} style={styles.sessionPanel}>
        {sessionsLoading && !sessions.length ? <Loading label="正在读取会话…" /> : sessions.length ? <View style={{ gap: 2 }}>
          {sessions.map((session, index) => {
            const uid = sessionUid(session);
            return uid ? <SessionRow key={`${uid}-${index}`} session={session} index={index} selected={uid === selectedUid} onPress={() => chooseSession(uid)} /> : null;
          })}
          {sessionHasMore && sessionCursor ? <SmallButton label="加载更多会话" disabled={sessionsLoading} onPress={() => void loadSessions(true, sessionCursor)} /> : null}
        </View> : <Empty lines={["当前账号没有可显示的私信会话。", "如果账号已登录但无权限，请检查 B 站会话。"]} />}
      </Panel>
      <Panel title={selectedSession ? sessionName(selectedSession) : "消息"} subtitle={selectedUid ? `UID ${selectedUid}` : undefined} style={styles.messagePanel}>
        {!selectedUid ? <Empty text="选择左侧会话查看消息。" /> : <MessageList
          selectedUid={selectedUid}
          messages={messages}
          messageHasMore={messageHasMore}
          messageCursor={messageCursor}
          messagesLoading={messagesLoading}
          draft={draft}
          sending={sending}
          onLoadMore={() => void loadMessages(selectedUid, messageCursor, true)}
          onDraftChange={setDraft}
          onSend={() => void sendMessage()}
        />}
      </Panel>
    </View>
  </ScrollView>;
}

export function BilibiliCreatorWorkspace({ connection, accountId, onOpenSettings, onManageAccount, privateMode = false }: WorkspaceProps) {
  const [panel, setPanel] = useState<CreatorPanel>("overview");
  const [metric, setMetric] = useState<TrendMetric>("play");
  const [page, setPage] = useState(1);
  const [videoBvid, setVideoBvid] = useState("");
  const [videoTarget, setVideoTarget] = useState("");
  const [payload, setPayload] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    setPayload(null);
    setError("");
    if (!connection || privateMode || (panel === "video" && !videoTarget)) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    const input: BilibiliProtocolInputs["creator/data"] = panel === "videos"
      ? { panel: "videos", page, pageSize: 20 }
      : panel === "video"
        ? { panel: "video", bvid: videoTarget }
        : panel === "trend"
          ? { panel: "trend", metric }
          : { panel };
    void callBilibiliProtocol(connection, accountId, "creator/data", input, controller.signal).then(result => {
      if (!controller.signal.aborted) setPayload(result.data);
    }, cause => {
      if (!controller.signal.aborted) setError(errorMessage(cause, "读取 B 站创作者数据失败。"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [accountId, connection, metric, page, panel, privateMode, reloadToken, videoTarget]);

  const setPanelAndReset = (value: CreatorPanel) => {
    setPanel(value);
    if (value === "videos") setPage(1);
  };

  const openVideo = (bvid: string) => {
    if (!bvid) return;
    setVideoBvid(bvid);
    setVideoTarget(bvid);
    setPanel("video");
  };

  if (privateMode) return <ScrollView style={styles.root} contentContainerStyle={styles.content}><PrivacyGate title="B 站创作者数据已隐藏" onOpenSettings={onOpenSettings} /></ScrollView>;
  if (!connection) return <ScrollView style={styles.root} contentContainerStyle={styles.content}><ConnectionGate title="连接采集器后查看 B 站创作者数据" onOpenSettings={onOpenSettings} /></ScrollView>;

  return <ScrollView testID="bilibili-creator-workspace" style={styles.root} contentContainerStyle={styles.content}>
    <View style={kit.between}>
      <View style={{ gap: 5 }}>
        <Text accessibilityRole="header" style={styles.title}>B 站创作者中心</Text>
      </View>
      <View style={kit.row}>
        {onManageAccount ? <SmallButton label="管理账号" onPress={onManageAccount} /> : null}
        <SmallButton label="刷新" disabled={loading} onPress={() => setReloadToken(value => value + 1)}>
          <RefreshCw size={14} color={color.text} />
        </SmallButton>
      </View>
    </View>
    <Tabs
      options={[
        { label: "数据总览", value: "overview" },
        { label: "受众", value: "audience" },
        { label: "粉丝", value: "fans" },
        { label: "趋势", value: "trend" },
        { label: "投稿", value: "videos" },
        { label: "单视频", value: "video" },
      ]}
      value={panel}
      onChange={setPanelAndReset}
    />
    {panel === "trend" ? <Tabs options={TREND_METRICS} value={metric} onChange={setMetric} /> : null}
    {panel === "videos" ? <View style={styles.toolbar}>
      <Text style={kit.muted}>第 {page} 页，每页 20 条</Text>
      <SmallButton label="上一页" disabled={page <= 1 || loading} onPress={() => setPage(value => Math.max(1, value - 1))} />
      <SmallButton label="下一页" disabled={loading} onPress={() => setPage(value => value + 1)} />
    </View> : null}
    {panel === "video" ? <View style={styles.videoSearch}>
      <SearchField
        label="BVID"
        placeholder="输入 BV 开头的视频号"
        value={videoBvid}
        onChange={setVideoBvid}
        onSubmit={() => setVideoTarget(videoBvid.trim())}
      />
      <SmallButton
        label="读取视频数据"
        disabled={!/^BV[0-9A-Za-z]{10}$/u.test(videoBvid.trim()) || loading}
        onPress={() => setVideoTarget(videoBvid.trim())}
      />
    </View> : null}
    {error ? <ErrorLine text={error} onRetry={() => setReloadToken(value => value + 1)} /> : null}
    <CreatorResult
      loading={loading}
      error={error}
      panel={panel}
      payload={payload}
      videoTarget={videoTarget}
      onOpenVideo={openVideo}
    />
  </ScrollView>;
}

function panelTitle(panel: CreatorPanel): string {
  return { overview: "数据总览", audience: "受众分析", fans: "粉丝数据", trend: "趋势", videos: "投稿列表", video: "单视频数据" }[panel];
}

function CreatorResult({
  loading,
  error,
  panel,
  payload,
  videoTarget,
  onOpenVideo,
}: {
  loading: boolean;
  error: string;
  panel: CreatorPanel;
  payload: unknown;
  videoTarget: string;
  onOpenVideo: (bvid: string) => void;
}) {
  if (loading) return <Loading label="正在读取 B 站创作者数据…" />;
  if (panel === "video" && !videoTarget) {
    return <Empty lines={["输入 BVID 后查看单个视频的播放、互动等数据。", "仅支持标准 BV 号。"]} />;
  }
  if (payload !== null) {
    return <Panel
      title={panelTitle(panel)}
      extra={<ExportButton build={async () => ({
        fileName: `bilibili_${panel}_${new Date().toISOString().slice(0, 10)}.csv`,
        rows: creatorExportRows(panel, payload),
      })} />}
    >
      <CreatorDataView panel={panel} payload={payload} onOpenVideo={onOpenVideo} />
    </Panel>;
  }
  return error ? null : <Empty text="暂无可显示的数据。" />;
}

function CreatorDataView({ panel, payload, onOpenVideo }: { panel: CreatorPanel; payload: unknown; onOpenVideo: (bvid: string) => void }) {
  const cards = scalarEntries(payload).slice(0, 12);
  const sections = recordSections(payload).slice(0, 8);
  return <View style={{ gap: 16 }}>
    {cards.length ? <View style={kit.grid}>
      {cards.map(([key, value]) => <MetricTile key={key} label={labelForKey(key.split(".").pop() ?? key)} value={value} />)}
    </View> : null}
    {sections.length ? sections.map(section => <View key={section.label} style={styles.dataSection}>
      <Text style={kit.subhead}>{section.label}</Text>
      {section.rows.slice(0, 30).map((row, index) => <CreatorRow key={`${section.label}-${index}`} row={row} index={index} onOpenVideo={onOpenVideo} />)}
    </View>) : null}
    {!cards.length && !sections.length ? <Empty text={`${panelTitle(panel)}暂时没有可展示的字段。`} /> : null}
  </View>;
}

function CreatorRow({ row, index, onOpenVideo }: { row: JsonRecord; index: number; onOpenVideo: (bvid: string) => void }) {
  const bvid = videoId(row);
  const values = scalarEntries(row).slice(0, 5);
  return <View style={styles.creatorRow}>
    <View style={{ flex: 1, minWidth: 220, gap: 4 }}>
      <Text style={styles.rowTitle}>{rowTitle(row, index)}</Text>
      <Text style={kit.muted}>{values.map(([key, value]) => `${labelForKey(key.split(".").pop() ?? key)} ${value}`).join(" · ")}</Text>
    </View>
    {bvid ? <SmallButton label="查看视频" onPress={() => onOpenVideo(bvid)} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  content: { maxWidth: 1100, width: "100%", alignSelf: "center", padding: 28, paddingBottom: 84, gap: 18 },
  gate: { alignItems: "center", justifyContent: "center", gap: 12, padding: 42, minHeight: 360, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  gateTitle: { color: color.text, fontFamily: font.body, fontSize: 18, fontWeight: "700", textAlign: "center" },
  title: { color: color.text, fontFamily: font.body, fontSize: 26, fontWeight: "700" },
  chatColumns: { flexDirection: "row", alignItems: "flex-start", gap: 18, flexWrap: "wrap" },
  sessionPanel: { flexGrow: 1, flexBasis: 260, minWidth: 250 },
  messagePanel: { flexGrow: 3, flexBasis: 420, minWidth: 320 },
  sessionRow: { flexDirection: "row", alignItems: "center", gap: 9, padding: 9, borderRadius: radius.small },
  sessionSelected: { backgroundColor: color.surfaceMuted },
  avatar: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: color.accentSoft },
  sessionBody: { flex: 1, minWidth: 0, gap: 3 },
  sessionName: { color: color.text, fontFamily: font.body, fontSize: 13, fontWeight: "600" },
  unread: { minWidth: 20, color: color.accent, fontFamily: font.body, fontSize: 11, textAlign: "right" },
  messageRow: { alignItems: "flex-start" },
  messageOutgoing: { alignItems: "flex-end" },
  messageBubble: { maxWidth: "82%", paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.small, color: color.textSecondary, fontFamily: font.body, fontSize: 13, lineHeight: 20, backgroundColor: color.surfaceRaised },
  messageBubbleOutgoing: { color: color.text, backgroundColor: color.accentSoft },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: color.borderSoft },
  composerInput: { flex: 1, minHeight: 42, maxHeight: 110 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  videoSearch: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  dataSection: { gap: 6 },
  creatorRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  rowTitle: { color: color.text, fontFamily: font.body, fontSize: 13, fontWeight: "600" },
});
