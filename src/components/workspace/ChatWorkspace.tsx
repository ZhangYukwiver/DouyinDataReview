import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  type TextProps,
  TextInput,
  View,
} from "react-native";
import {
  Check,
  ChevronLeft,
  FileText,
  Flame,
  Image as ImageIcon,
  LockKeyhole,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Phone,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Smile,
  UsersRound,
  Video,
  X,
} from "lucide-react-native";

import {
  countChatMessages,
  type ChatConversationKind,
  type ChatConversationSummary,
  type ChatMessage,
  hasChatShareEvidence,
} from "../../domain/chatRecords";
import { buildSparks, mergeOfficialSparks, shiftDay, SPARK_LIT_DAYS, sparkDayKey, type OfficialStreak, type Spark, type SparkDay } from "../../domain/chatSparks";
import { loadChatStreaks, loadLiveMessages } from "../../services/chatLive";
import { CHAT_SEND_UNCONFIRMED, sendChatMessage, type ChatSendConnection, type ChatSendOutcome } from "../../services/chatSend";
import { MAX_SPARK_BATCH, sparkRenewJob, type SparkPayload, type SparkRenewRun, type SparkSendState, type SparkSendUpdate } from "../../services/sparkRenew";
import type { PersonalRecordCollection, PersonalVideoRecord } from "../../domain/personalRecords";
import { type CollectorStatus, LocalCollectorError, isChatReceiving } from "../../services/localCollector";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { fx, ws } from "./motion";
import { CHAT_EMOJI } from "../../domain/chatEmoji";
import { renderEmojiText } from "./emojiText";

const webPointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;
const CHAT_MESSAGE_RENDER_LIMIT = 320;
// 与抖音网页输入框的上限一致
const CHAT_TEXT_LIMIT = 16_000;
// 原生 textarea 按内容长高（Chromium 123+）
const webAutoHeight = Platform.OS === "web" ? ({ fieldSizing: "content" } as object) : null;

type ChatFilter = "all" | "friend" | "group";

export interface ChatWorkspaceProps {
  mobile: boolean;
  messages: ChatMessage[];
  conversations: ChatConversationSummary[];
  privacy: boolean;
  busy: boolean;
  connected?: boolean;
  status?: CollectorStatus | null;
  onToggleReception?: () => void;
  onCollectHistory?: () => void;
  /** 有连接才能发送；消息经采集器里的抖音网页发出。 */
  sendConnection?: ChatSendConnection | null;
  /** 续火花选视频用：喜欢和收藏里的作品。 */
  videoRecords?: PersonalRecordCollection;
  onOpenRecord: (url: string) => Promise<void>;
  onOpenSettings: () => void;
}

export interface ChatConversationRow {
  id: string;
  kind: ChatConversationKind;
  name: string;
  avatarUrl: string | null;
  messages: ChatMessage[];
  messageCount: number;
  ownMessageCount: number;
  latest: ChatMessage | null;
  latestAt: string | null;
  /** 对方最后活跃的时刻，抖音下发；没开在线状态或没采到就是 null。 */
  lastActiveAt: string | null;
  preview: string;
  initials: string;
  accent: string;
}

const avatarPalette = color.avatars;
const MESSAGE_AUTO_SCROLL_THRESHOLD = 72;
const HOUR_MS = 3_600_000;
// 抖音网页自己的判定：最后活跃在 10 分钟内算“在线”，超过 7 小时就只说今天/昨天，
// 再早什么都不说。这些数字照抄站点，换成我们自己的阈值只会和抖音对不上。
const ACTIVE_DELAY_MS = 600_000;
const COARSE_AFTER_MS = 25_200_000;

/** 把抖音下发的“最后活跃时刻”翻成它自己那套说法。 */
export function chatPresence(lastActiveAt: string | null | undefined): { online: boolean; text: string } {
  const activeAt = lastActiveAt ? Date.parse(lastActiveAt) : Number.NaN;
  if (!Number.isFinite(activeAt)) return { online: false, text: "" };
  const elapsed = Math.max(0, Date.now() - activeAt - ACTIVE_DELAY_MS);
  if (elapsed <= 0) return { online: true, text: "在线" };
  if (elapsed >= COARSE_AFTER_MS) {
    const todayStart = new Date().setHours(0, 0, 0, 0);
    if (activeAt < todayStart - 24 * HOUR_MS) return { online: false, text: "" };
    return { online: false, text: activeAt < todayStart ? "昨天在线" : "今天在线" };
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes <= 59) return { online: false, text: `${Math.max(1, minutes)}分钟内在线` };
  return { online: false, text: `${Math.max(1, Math.floor(elapsed / HOUR_MS))}小时内在线` };
}

/**
 * Build the list shown by the chat UI from the collector's normalized
 * conversation catalog and friend message snapshot. Group message bodies are
 * intentionally absent at the collector boundary, so group rows remain
 * summary-only and never pretend to contain readable content.
 */
export function buildChatConversationRows(
  messages: readonly ChatMessage[],
  conversations: readonly ChatConversationSummary[],
): ChatConversationRow[] {
  const byId = new Map<string, {
    id: string;
    kind: ChatConversationKind;
    rawName: string | null;
    avatarUrl: string | null;
    messages: ChatMessage[];
    messageCount: number;
    ownMessageCount: number;
    lastActiveAt: string | null;
  }>();

  for (const conversation of conversations) {
    byId.set(conversation.id, {
      id: conversation.id,
      kind: conversation.kind,
      rawName: cleanText(conversation.name),
      avatarUrl: safeChatAvatarUrl(conversation.avatarUrl),
      messages: [],
      messageCount: Math.max(0, conversation.messageCount),
      ownMessageCount: Math.max(0, conversation.ownMessageCount),
      lastActiveAt: conversation.lastActiveAt ?? null,
    });
  }

  for (const message of messages) {
    if (message.conversationType === "group") continue;
    const id = message.conversationId?.trim()
      || (message.conversationName?.trim() ? `name:${message.conversationName.trim()}` : `message:${message.id}`);
    const current = byId.get(id) ?? {
      id,
      kind: message.conversationType ?? "unknown",
      rawName: cleanText(message.conversationName),
      avatarUrl: null,
      messages: [],
      messageCount: 0,
      ownMessageCount: 0,
      lastActiveAt: null,
    };
    current.kind = current.kind === "friend" || message.conversationType === "friend"
      ? "friend"
      : current.kind;
    current.rawName ??= cleanText(message.conversationName);
    current.avatarUrl ??= safeChatAvatarUrl(message.senderAvatarUrl);
    current.messages.push(message);
    current.messageCount = Math.max(current.messageCount, current.messages.length);
    byId.set(id, current);
  }

  // 只有抖音系统提示、没有一句真消息的会话不算聊天（比如抖音顺手建出来的空会话），不进列表
  const rows = [...byId.values()].filter((entry) => entry.kind === "group" || !entry.messages.length || entry.messages.some((message) => message.type !== "system")).map((entry) => {
    const sortedMessages = [...entry.messages].sort(compareMessageTime);
    const latest = sortedMessages[sortedMessages.length - 1] ?? null;
    // Unsupported payloads can arrive after a readable message. Keep the
    // newest timestamp for ordering, but prefer the newest useful preview so
    // the list does not become a wall of identical "暂未解析" labels.
    const readableLatest = [...sortedMessages].reverse().find((message) => {
      const preview = chatPreview(message);
      return preview !== "暂未解析的消息";
    }) ?? latest;
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.rawName ?? "",
      avatarUrl: entry.avatarUrl,
      messages: sortedMessages,
      messageCount: entry.messageCount,
      ownMessageCount: entry.ownMessageCount,
      latest,
      latestAt: latest?.sentAt ?? null,
      lastActiveAt: entry.lastActiveAt,
      preview: readableLatest ? chatPreview(readableLatest) : entry.kind === "group" ? `群聊 · 已采集 ${entry.messageCount} 条消息` : "暂无可显示的消息正文",
      initials: "",
      accent: avatarPalette[hashString(entry.id) % avatarPalette.length] ?? avatarPalette[0]!,
    } satisfies ChatConversationRow;
  });

  rows.sort((left, right) => {
    const timeDiff = messageTime(right.latestAt) - messageTime(left.latestAt);
    return timeDiff || right.messageCount - left.messageCount || left.id.localeCompare(right.id);
  });

  return rows.map((row, index) => {
    // 1:1 会话 ID 两边是同一个 uid，就是发给自己的那个会话
    const fallback = row.kind === "group" ? `群聊 ${String(index + 1).padStart(2, "0")}` : /^0:1:(\d+):\1$/u.test(row.id) ? "我自己" : `好友会话 ${String(index + 1).padStart(2, "0")}`;
    const name = row.name || fallback;
    return { ...row, name, initials: initialsFor(name, row.kind) };
  });
}

export function ChatWorkspace({
  mobile,
  messages,
  conversations,
  privacy,
  busy,
  connected = false,
  status = null,
  onToggleReception,
  onCollectHistory,
  sendConnection = null,
  videoRecords,
  onOpenRecord,
  onOpenSettings,
}: ChatWorkspaceProps) {
  const rows = useMemo(() => buildChatConversationRows(messages, conversations), [conversations, messages]);
  const selfId = useMemo(() => inferSelfId(messages), [messages]);
  const [sparkBoard, setSparkBoard] = useState(false);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const searchRef = useRef<TextInput>(null);
  const now = useMinuteClock();
  const friendRows = useMemo(() => rows.filter((row) => row.kind !== "group"), [rows]);
  // 抖音自己的火花（好友和群都有）从采集器里开着的聊天页现读，每 5 分钟和打开看板时刷新一次
  const receivingNow = isChatReceiving(status);
  const liveReady = Boolean(sendConnection && connected && receivingNow && status?.chat.state === "observing" && !status.chat.progress);
  const [official, setOfficial] = useState<OfficialStreak[] | null>(null);
  useEffect(() => {
    if (!liveReady || !sendConnection) { setOfficial(null); return; }
    let current = true;
    const load = () => loadChatStreaks(sendConnection).then((value) => { if (current) setOfficial(value); }).catch(() => {});
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => { current = false; clearInterval(timer); };
  }, [liveReady, sendConnection?.baseUrl, sendConnection?.token, sparkBoard]);
  const sparks = useMemo(() => mergeOfficialSparks(buildSparks(friendRows, selfId, now), official, now), [friendRows, now, official, selfId]);
  const sparkAlerts = sparks.filter((spark) => spark.state === "pending" && (spark.official !== undefined || spark.days >= SPARK_LIT_DAYS)).length;
  const shareVideos = useMemo(() => {
    const seen = new Set<string>();
    return [...(videoRecords?.favorite_videos ?? []), ...(videoRecords?.liked_videos ?? [])].filter((record) => {
      if (!record.videoId || !record.url || record.mediaType === "image" || record.mediaType === "live" || seen.has(record.videoId)) return false;
      seen.add(record.videoId);
      return true;
    }).slice(0, 60);
  }, [videoRecords]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return rows.filter((row) => {
      if (filter === "group" && row.kind !== "group") return false;
      if (filter === "friend" && row.kind === "group") return false;
      if (!normalizedQuery) return true;
      if (privacy) {
        const masked = `${row.kind === "group" ? "群聊" : "好友"} 聊天内容已隐藏`.toLocaleLowerCase("zh-CN");
        return masked.includes(normalizedQuery);
      }
      if (`${row.name} ${row.preview}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) return true;
      return row.messages.some((message) => {
        const searchable = [message.text, message.senderName, message.share?.title, message.share?.author, message.comment?.author, message.comment?.text]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("zh-CN");
        return searchable.includes(normalizedQuery);
      });
    });
  }, [filter, privacy, query, rows]);

  useEffect(() => {
    if (!selectedId || !rows.some((row) => row.id === selectedId)) {
      const fallback = filteredRows[0] ?? rows[0] ?? null;
      if (fallback?.id !== selectedId) setSelectedId(fallback?.id ?? null);
      return;
    }
    // On desktop, changing a filter/search term should make the detail pane
    // follow the first visible result instead of leaving an unrelated chat
    // open on the right.
    if (filteredRows.length > 0 && !filteredRows.some((row) => row.id === selectedId)) {
      setSelectedId(filteredRows[0]!.id);
    }
  }, [filteredRows, rows, selectedId]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const selectedForDetail = query.trim() && filteredRows.length === 0 ? null : selected;
  const showDetail = !mobile || mobileDetail || sparkBoard;
  const totalMessages = countChatMessages(messages, conversations);

  const selectConversation = (row: ChatConversationRow) => {
    setSparkBoard(false);
    setSelectedId(row.id);
    if (mobile) setMobileDetail(true);
  };
  // 从看板跳过去时清掉筛选和搜索，否则被筛掉的会话会被上面的 effect 换成列表第一项。
  const openFromBoard = (row: ChatConversationRow) => {
    setFilter("all");
    setQuery("");
    selectConversation(row);
  };

  const receiving = isChatReceiving(status);
  const chatError = status?.chat.state === "error" ? status.chat.message : null;
  const receptionLabel = !connected ? "未连接采集器"
    : chatError ? "聊天接收失败"
      : !receiving ? "已暂停接收"
      : status?.chatConnection === "connected" ? "实时接收中"
        : status?.chatConnection === "reconnecting" ? "连接中断，正在重连" : "正在连接消息";
  const controlDisabled = connected && busy && !receiving;
  // 发送借用正在接收的抖音网页，所以要等历史整理完、连接就绪。
  const sendBlock = !sendConnection || !connected ? "连接采集器后才能发消息"
    : !receiving ? "开始接收后才能发消息"
      : status?.chat.state !== "observing" || status.chat.progress ? "聊天历史整理完就能发消息"
        : status.chatConnection !== "connected" ? "消息连接好了才能发"
          : privacy ? "隐私模式下不能发消息" : null;
  const sendMessage = (conversationId: string, text: string) => sendChatMessage(sendConnection!, conversationId, text);
  const renewRun = useSyncExternalStore(sparkRenewJob.subscribe, sparkRenewJob.snapshot);

  return (
    <View style={styles.workspace} testID="chat-workspace">
      <View {...ws("c-bar g-ink")} style={styles.receptionBar}>
        <View style={styles.receptionCopy}>
          <View {...ws("dot", receiving && status?.chatConnection === "connected" && "on")} style={[styles.receptionDot, { backgroundColor: receiving && status?.chatConnection === "connected" ? color.green : color.textMuted }]} />
          <Text {...ws("mono")} accessibilityLiveRegion="polite" style={styles.receptionLabel}>{receptionLabel}</Text>
          {chatError
            ? <Text accessibilityLiveRegion="polite" numberOfLines={1} style={styles.receptionError}>{chatError}</Text>
            : receiving && status?.chat.progress
              ? <Text style={styles.receptionProgress}>整理历史 {status.chat.progress.current}/{status.chat.progress.total || "…"}</Text>
              : null}
        </View>
        <View style={styles.receptionActions}>
          {renewRun ? <SparkRenewStatus run={renewRun} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={!connected ? "连接采集器" : receiving ? "暂停接收" : "开始接收"}
            accessibilityState={{ disabled: controlDisabled }}
            disabled={controlDisabled}
            onPress={!connected ? onOpenSettings : onToggleReception}
            {...ws("btn small")}
            style={({ pressed }) => [styles.receptionButton, pressed && styles.pressed, controlDisabled && { opacity: 0.45 }, webPointer]}
          >
            {receiving ? <Pause color={color.textSecondary} size={13} /> : <Play color={color.textSecondary} size={13} />}
            <Text style={styles.receptionButtonText}>{!connected ? "连接采集器" : receiving ? "暂停接收" : "开始接收"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="采集聊天记录"
            accessibilityState={{ disabled: !connected || busy || !onCollectHistory }}
            disabled={!connected || busy || !onCollectHistory}
            onPress={onCollectHistory}
            {...ws("btn small")}
            style={({ pressed }) => [styles.receptionButton, pressed && styles.pressed, (!connected || busy || !onCollectHistory) && { opacity: 0.45 }, webPointer]}
          >
            {busy ? <ActivityIndicator color={color.textSecondary} size="small" /> : <RefreshCw color={color.textSecondary} size={13} />}
            <Text style={styles.receptionButtonText}>采集聊天记录</Text>
          </Pressable>
        </View>
      </View>
      <View style={[styles.root, mobile && styles.rootMobile]}>
      {!showDetail ? (
        <ChatListPane
          busy={busy}
          filter={filter}
          mobile={mobile}
          onChangeFilter={setFilter}
          onFocusSearch={() => searchRef.current?.focus()}
          onOpenSettings={onOpenSettings}
          onSelect={selectConversation}
          onToggleSparks={() => setSparkBoard((open) => !open)}
          sparkAlerts={sparkAlerts}
          sparkBoard={sparkBoard}
          query={query}
          allRows={rows}
          rows={filteredRows}
          searchRef={searchRef}
          setQuery={setQuery}
          totalMessages={totalMessages}
          privacy={privacy}
        />
      ) : (
        <>
          {!mobile ? (
            <ChatListPane
              busy={busy}
              filter={filter}
              mobile={mobile}
              onChangeFilter={setFilter}
              onFocusSearch={() => searchRef.current?.focus()}
              onOpenSettings={onOpenSettings}
              onSelect={selectConversation}
              onToggleSparks={() => setSparkBoard((open) => !open)}
              sparkAlerts={sparkAlerts}
              sparkBoard={sparkBoard}
              query={query}
              allRows={rows}
              rows={filteredRows}
              searchRef={searchRef}
              setQuery={setQuery}
              totalMessages={totalMessages}
              privacy={privacy}
              selectedId={sparkBoard ? null : selectedId}
            />
          ) : null}
          {sparkBoard ? (
            <SparkBoard
              live={receiving && status?.chatConnection === "connected"}
              mobile={mobile}
              now={now}
              onBack={() => setSparkBoard(false)}
              onOpen={openFromBoard}
              privacy={privacy}
              rows={rows}
              sendBlock={sendBlock}
              sendConnection={sendConnection}
              selfId={selfId}
              sparks={sparks}
              targets={rows}
              videos={shareVideos}
            />
          ) : <ChatDetailPane
            key={selectedForDetail?.id ?? "none"}
            mobile={mobile}
            onBack={() => setMobileDetail(false)}
            onOpenRecord={onOpenRecord}
            privacy={privacy}
            row={selectedForDetail}
            selfId={selfId}
            sendBlock={sendBlock}
            onSend={sendMessage}
            live={liveReady ? sendConnection : null}
          />}
        </>
      )}
      </View>
    </View>
  );
}

function ChatListPane({
  busy,
  filter,
  mobile,
  onChangeFilter,
  onFocusSearch,
  onOpenSettings,
  onSelect,
  onToggleSparks,
  sparkAlerts,
  sparkBoard,
  query,
  allRows,
  rows,
  searchRef,
  setQuery,
  totalMessages,
  privacy,
  selectedId,
}: {
  busy: boolean;
  filter: ChatFilter;
  mobile: boolean;
  onChangeFilter: (filter: ChatFilter) => void;
  onFocusSearch: () => void;
  onOpenSettings: () => void;
  onSelect: (row: ChatConversationRow) => void;
  onToggleSparks: () => void;
  sparkAlerts: number;
  sparkBoard: boolean;
  query: string;
  allRows: ChatConversationRow[];
  rows: ChatConversationRow[];
  searchRef: React.RefObject<TextInput | null>;
  setQuery: (value: string) => void;
  totalMessages: number;
  privacy: boolean;
  selectedId?: string | null;
}) {
  const filters: Array<{ id: ChatFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: allRows.length },
    { id: "friend", label: "好友", count: allRows.filter((row) => row.kind !== "group").length },
    { id: "group", label: "群聊", count: allRows.filter((row) => row.kind === "group").length },
  ];

  return (
    <View {...ws("c-list")} style={[styles.listPane, mobile && styles.listPaneMobile]}>
      <View {...ws("c-head")} style={styles.listHeader}>
        <View style={styles.listHeaderCopy}>
          <Text {...ws("c-title")} style={styles.chatTitle}>消息</Text>
          <Text {...ws("mono")} style={styles.chatSubtitle}>{allRows.length ? `${formatCount(allRows.length)} 个会话 · ${formatCount(totalMessages)} 条消息` : "消息会保存在本机"}</Text>
        </View>
        <Pressable
          accessibilityLabel={sparkAlerts ? `火花看板，${sparkAlerts} 位好友的火花今天还没续` : "火花看板"}
          accessibilityRole="button"
          accessibilityState={{ selected: sparkBoard }}
          {...fx({ hover: "raise", ws: sparkBoard ? "btn square on" : "btn square" })}
          onPress={onToggleSparks}
          style={({ pressed }) => [styles.iconButton, sparkBoard && styles.iconButtonActive, pressed && styles.pressed, webPointer]}
          testID="chat-spark-toggle"
        >
          <Flame color={sparkBoard || sparkAlerts ? color.amber : color.textSecondary} size={19} strokeWidth={2} />
          {sparkAlerts ? (
            <View {...ws("stamp-sig c-badge")} style={styles.sparkBadge}>
              <Text style={styles.sparkBadgeText}>{sparkAlerts}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable
          accessibilityLabel="聚焦搜索聊天"
          accessibilityRole="button"
          {...fx({ hover: "raise", ws: "btn square" })}
          onPress={onFocusSearch}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, webPointer]}
        >
          <Search color={color.textSecondary} size={19} strokeWidth={2} />
        </Pressable>
      </View>

      <View {...ws("c-search")} style={styles.searchBox}>
        <Search color={color.textMuted} size={16} strokeWidth={2} />
        <TextInput
          accessibilityLabel="搜索聊天"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="搜索会话或消息"
          placeholderTextColor={color.textMuted}
          ref={searchRef}
          returnKeyType="search"
          selectionColor={color.cyan}
          style={styles.searchInput}
          value={query}
        />
        {query ? (
          <Pressable accessibilityLabel="清除聊天搜索" accessibilityRole="button" onPress={() => setQuery("")} style={[styles.searchClear, webPointer]}>
            <X color={color.textMuted} size={14} />
          </Pressable>
        ) : null}
      </View>

      <View {...ws("c-filters")} accessibilityRole="tablist" style={styles.filterRow}>
        {filters.map((item) => (
          <Pressable
            accessibilityLabel={`${item.label}，${item.count} 个会话`}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === item.id }}
            key={item.id}
            {...fx({ hover: "tint", ws: filter === item.id ? "c-filter on" : "c-filter" })}
            onPress={() => onChangeFilter(item.id)}
            style={({ pressed }) => [styles.filterTab, filter === item.id && styles.filterTabActive, pressed && styles.pressed, webPointer]}
          >
            <Text style={[styles.filterTabText, filter === item.id && styles.filterTabTextActive]}>{item.label}</Text>
            <Text style={[styles.filterTabCount, filter === item.id && styles.filterTabCountActive]}>{item.count}</Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        contentContainerStyle={[styles.conversationListContent, rows.length === 0 && styles.conversationListEmpty]}
        data={rows}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={(
          <ChatListEmpty busy={busy} hasQuery={Boolean(query.trim())} onOpenSettings={onOpenSettings} privacy={privacy} />
        )}
        renderItem={({ item, index }) => (
          <ConversationListItem
            index={index}
            onPress={() => onSelect(item)}
            privacy={privacy}
            row={item}
            selected={item.id === selectedId}
          />
        )}
        showsVerticalScrollIndicator={false}
        style={styles.conversationList}
      />
    </View>
  );
}

function ConversationListItem({
  index,
  onPress,
  privacy,
  row,
  selected,
}: {
  index: number;
  onPress: () => void;
  privacy: boolean;
  row: ChatConversationRow;
  selected: boolean;
}) {
  const visibleName = privacy ? (row.kind === "group" ? "群聊" : "好友") : row.name;
  const visiblePreview = privacy ? "聊天内容已隐藏" : row.preview;
  const presence = chatPresence(row.lastActiveAt);
  return (
    <Pressable
      {...fx({ motion: "rise", i: index < 12 ? index + 1 : 0, hover: "tint", ws: selected ? "c-conv on" : "c-conv" })}
      accessibilityLabel={`${visibleName}，${row.messageCount} 条聊天消息`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.conversationItem, selected && styles.conversationItemSelected, pressed && styles.pressed, webPointer]}
      testID={`chat-conversation-${row.id}`}
    >
      <ChatAvatar avatarUrl={row.avatarUrl} initials={row.initials} accent={row.accent} kind={row.kind} online={presence.online} privacy={privacy} size={48} />
      <View style={styles.conversationCopy}>
        <View style={styles.conversationTopLine}>
          <Text {...ws("c-name")} numberOfLines={1} style={styles.conversationName}>{visibleName}</Text>
          <Text {...ws("mono")} style={styles.conversationTime}>{formatChatListTime(row.latestAt)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.conversationPreview}>{visiblePreview}</Text>
        <View style={styles.conversationMeta}>
          <Text style={styles.conversationKind}>{row.kind === "group" ? "群聊摘要" : row.kind === "unknown" ? "私聊" : "好友对话"}</Text>
          <Text {...ws("mono c-count")} style={styles.conversationCount}>{formatCount(row.messageCount)} 条</Text>
        </View>
      </View>
      {selected ? <View {...ws("c-mark")} style={styles.conversationActiveMark} /> : null}
    </Pressable>
  );
}

function ChatListEmpty({ busy, hasQuery, onOpenSettings, privacy }: { busy: boolean; hasQuery: boolean; onOpenSettings: () => void; privacy: boolean }) {
  if (hasQuery) {
    return (
      <View {...fx({ motion: "rise" })} style={styles.listEmptyState}>
        <Search color={color.textMuted} size={26} strokeWidth={1.7} />
        <Text style={styles.listEmptyTitle}>没有匹配的会话</Text>
        <Text style={styles.listEmptyBody}>换一个关键词试试。</Text>
      </View>
    );
  }
  return (
    <View {...fx({ motion: "rise" })} style={styles.listEmptyState}>
      <View {...ws("w-emptyicon")} style={styles.emptyChatIcon}><MessageCircle color={color.cyan} size={25} strokeWidth={1.8} /></View>
      <Text {...ws("w-emptytitle small")} style={styles.listEmptyTitle}>{busy ? "正在整理聊天" : "还没有聊天快照"}</Text>
      <Text style={styles.listEmptyBody}>{privacy ? "隐私模式已开启；读取后仍只在本机显示。" : "连接采集器后读取聊天，即可在这里回看好友对话。"}</Text>
      <Pressable {...ws("btn-solid")} accessibilityRole="button" onPress={onOpenSettings} style={({ pressed }) => [styles.emptyAction, pressed && styles.pressed, webPointer]}>
        <Text style={styles.emptyActionText}>连接与采集</Text>
      </Pressable>
    </View>
  );
}

function ChatDetailPane({
  live,
  mobile,
  onBack,
  onOpenRecord,
  onSend,
  privacy,
  row,
  selfId,
  sendBlock,
}: {
  /** 能现读抖音网页时给连接：群消息不落盘，打开群才从那边读 */
  live: ChatSendConnection | null;
  mobile: boolean;
  onBack: () => void;
  onOpenRecord: (url: string) => Promise<void>;
  onSend: (conversationId: string, text: string) => Promise<ChatSendOutcome>;
  privacy: boolean;
  row: ChatConversationRow | null;
  selfId: string | null;
  sendBlock: string | null;
}) {
  const messageListRef = useRef<FlatList<ChatMessage>>(null);
  const stickToBottomRef = useRef(true);
  const group = row?.kind === "group" && live ? live : null;
  const groupMessages = useGroupMessages(group, row?.id ?? null);

  // 网页端直接按 DOM 尺寸定位：FlatList 自带的 scrollToEnd 靠尚未量到的行高估算，
  // 会先落在顶部再逐批往下跳。用内容容器的高度而不是 scrollHeight，入场动画的位移不会把它撑高。
  const scrollToBottom = () => {
    const node = messageListRef.current?.getScrollableNode?.();
    if (typeof node?.scrollHeight !== "number") {
      messageListRef.current?.scrollToEnd({ animated: false });
      return;
    }
    node.scrollTop = (node.firstElementChild?.offsetHeight ?? node.scrollHeight) - node.clientHeight;
  };

  // 切换会话时本组件按会话 id 重新挂载：气泡在首次提交里一次渲染完（initialNumToRender），
  // 绘制前就把列表拉到最新一条，不会先看到最早的消息再往下跳。
  useLayoutEffect(scrollToBottom, []);
  // 群消息：第一页到了拉到底；往上翻加载的更早消息插在前面时，保持眼前这一屏不动
  const firstGroupPageRef = useRef(true);
  useLayoutEffect(() => {
    const node = messageListRef.current?.getScrollableNode?.();
    if (!group || !groupMessages.messages.length || typeof node?.scrollHeight !== "number") return;
    const height = node.firstElementChild?.offsetHeight ?? node.scrollHeight;
    if (groupMessages.keepFromBottom.current !== null) {
      node.scrollTop = height - groupMessages.keepFromBottom.current;
      groupMessages.keepFromBottom.current = null;
    } else if (firstGroupPageRef.current || stickToBottomRef.current) scrollToBottom();
    firstGroupPageRef.current = false;
  }, [groupMessages.messages]);

  if (!row) {
    return (
      <View style={[styles.detailPane, mobile && styles.detailPaneMobile]}>
        <View {...fx({ motion: "rise" })} style={styles.detailEmptyState}>
          <View {...ws("w-emptyicon")} style={styles.emptyChatIcon}><MessageCircle color={color.cyan} size={26} strokeWidth={1.8} /></View>
          <Text {...ws("w-emptytitle small")} style={styles.detailEmptyTitle}>选择一个会话</Text>
          <Text style={styles.detailEmptyBody}>从左侧列表打开好友对话。</Text>
        </View>
      </View>
    );
  }

  const visibleName = privacy ? (row.kind === "group" ? "群聊" : "好友") : row.name;
  const presence = chatPresence(row.lastActiveAt);
  const visibleMessages = group ? groupMessages.messages : row.messages.length > CHAT_MESSAGE_RENDER_LIMIT
    ? row.messages.slice(-CHAT_MESSAGE_RENDER_LIMIT)
    : row.messages;
  const omitted = group ? 0 : row.messages.length - visibleMessages.length;
  const loadOlder = () => {
    const node = messageListRef.current?.getScrollableNode?.();
    groupMessages.loadOlder(typeof node?.scrollHeight === "number" ? (node.firstElementChild?.offsetHeight ?? node.scrollHeight) - node.scrollTop : null);
  };
  const handleMessageScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    if (Number.isFinite(distanceFromBottom)) {
      stickToBottomRef.current = distanceFromBottom <= MESSAGE_AUTO_SCROLL_THRESHOLD;
    }
    // 只有往上滑到顶才去抖音那边翻更早的一页
    if (group && contentOffset.y < 80 && groupMessages.hasMore && !groupMessages.loading) loadOlder();
  };

  return (
    <View {...fx({ motion: "fade" })} style={[styles.detailPane, mobile && styles.detailPaneMobile]}>
      <View {...ws("c-dhead")} style={styles.detailHeader}>
        {mobile ? (
          <Pressable accessibilityLabel="返回聊天列表" accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.detailBackButton, pressed && styles.pressed, webPointer]}>
            <ChevronLeft color={color.textSecondary} size={21} strokeWidth={2} />
          </Pressable>
        ) : null}
        <ChatAvatar avatarUrl={row.avatarUrl} initials={row.initials} accent={row.accent} kind={row.kind} online={presence.online} privacy={privacy} size={38} />
        <View style={styles.detailHeaderCopy}>
          <Text {...ws("c-dtitle")} numberOfLines={1} style={styles.detailTitle}>{visibleName}</Text>
          <Text {...ws("mono")} style={styles.detailMeta}>
            {presence.text ? `${presence.text} · ` : ""}
            {row.kind === "group" ? group ? "群消息从抖音现读，不存到本机" : "群聊统计摘要" : `${formatCount(row.messageCount)} 条本地消息`}
          </Text>
        </View>
        <View style={styles.detailHeaderActions}>
          <View {...ws("stamp-ghost c-ro")} style={styles.readonlyBadge}>
            <ShieldCheck color={color.green} size={13} strokeWidth={2} />
            <Text style={styles.readonlyBadgeText}>{group ? "不存本机" : "本地保存"}</Text>
          </View>
          <Pressable {...ws("btn square")} accessibilityLabel="聊天详情" accessibilityRole="button" style={[styles.iconButton, webPointer]}>
            <MoreHorizontal color={color.textMuted} size={19} />
          </Pressable>
        </View>
      </View>

      {privacy ? (
        <View {...ws("stamp-bar")} style={styles.privacyNotice}>
          <LockKeyhole color={color.cyan} size={15} strokeWidth={2} />
          <Text style={styles.privacyNoticeText}>隐私模式已开启，联系人和消息正文已隐藏。</Text>
        </View>
      ) : null}

      {row.kind === "group" && !group ? (
        <GroupSummary row={row} privacy={privacy} />
      ) : (
        <FlatList
          contentContainerStyle={styles.messageListContent}
          data={visibleMessages}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={group ? <Text style={styles.messageLimitNotice}>{groupMessages.error ?? "正在从抖音读取群消息…"}</Text> : <MessageListEmpty privacy={privacy} />}
          ListHeaderComponent={group ? (visibleMessages.length ? <GroupHistoryHeader error={groupMessages.error} hasMore={groupMessages.hasMore} loading={groupMessages.loading} onLoad={loadOlder} /> : null)
            : omitted > 0 ? <Text style={styles.messageLimitNotice}>仅显示最近 {CHAT_MESSAGE_RENDER_LIMIT} 条，另有 {omitted} 条更早消息保留在本地快照中。</Text> : <ConversationDateDivider />}
          // 群消息是用户自己一页页翻出来的，全部渲染，免得虚拟列表估高让插入的旧消息跳位
          initialNumToRender={Math.max(CHAT_MESSAGE_RENDER_LIMIT, visibleMessages.length)}
          windowSize={group ? 999 : undefined}
          onContentSizeChange={() => {
            if (stickToBottomRef.current) scrollToBottom();
          }}
          onScroll={handleMessageScroll}
          ref={messageListRef}
          // 最后八条依次入场（越靠底越晚），像消息刚刚到达
          renderItem={({ item, index }) => <ChatMessageBubble i={Math.max(0, index - (visibleMessages.length - 8) + 1)} message={item} onOpenRecord={onOpenRecord} privacy={privacy} row={row} selfId={selfId} />}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          style={styles.messageList}
        />
      )}

      <ChatComposer
        blockedReason={sendBlock}
        hidden={privacy}
        onSend={(text) => onSend(row.id, text)}
        onSent={() => {
          stickToBottomRef.current = true;
          scrollToBottom();
          if (group) groupMessages.refresh();
        }}
        // 读不到群消息时（没在接收），发出去这里看不到，只能靠一句提示
        sentNotice={row.kind === "group" && !group ? "已发到群里。群消息不会存到本机，所以这里不显示。" : undefined}
      />
    </View>
  );
}

// 群消息只在打开群时从采集器里的抖音网页读：先拿网页手里的最新一批（不用点开会话），
// 往上翻到顶才让网页再加载更早的一页；开着的时候每 20 秒补一次新消息。结果只在内存里。
function useGroupMessages(connection: ChatSendConnection | null, conversationId: string | null) {
  const [state, setState] = useState<{ messages: ChatMessage[]; hasMore: boolean; loading: boolean; error: string | null }>({ messages: [], hasMore: false, loading: false, error: null });
  const keepFromBottom = useRef<number | null>(null);
  const busy = useRef(false);
  const load = async (older: boolean, fromBottom: number | null = null) => {
    if (!connection || !conversationId || busy.current) return;
    busy.current = true;
    setState((value) => ({ ...value, loading: true }));
    try {
      const page = await loadLiveMessages(connection, conversationId, older);
      setState((value) => {
        const byId = new Map(value.messages.map((message) => [message.id, message]));
        const before = byId.size;
        for (const message of page.messages) byId.set(message.id, message);
        // 往上翻却一条新的都没多，说明到头了（比如入群前的消息看不到）
        if (older) keepFromBottom.current = byId.size > before ? fromBottom : null;
        return {
          messages: [...byId.values()].sort((left, right) => messageTime(left.sentAt) - messageTime(right.sentAt)),
          hasMore: older && byId.size === before ? false : page.hasMore,
          loading: false,
          error: null,
        };
      });
    } catch (error) {
      setState((value) => ({ ...value, loading: false, error: error instanceof Error ? error.message : "暂时读不到群消息，请稍后再试。" }));
    } finally { busy.current = false; }
  };
  useEffect(() => {
    if (!connection || !conversationId) return;
    void load(false);
    const timer = setInterval(() => void load(false), 20_000);
    return () => clearInterval(timer);
  }, [connection?.baseUrl, connection?.token, conversationId]);
  return { ...state, keepFromBottom, loadOlder: (fromBottom: number | null) => void load(true, fromBottom), refresh: () => void load(false) };
}

function GroupHistoryHeader({ error, hasMore, loading, onLoad }: { error: string | null; hasMore: boolean; loading: boolean; onLoad: () => void }) {
  if (loading) return <View style={styles.groupHistoryHead}><ActivityIndicator color={color.textMuted} size="small" /><Text style={styles.messageLimitNotice}>正在加载更早的消息…</Text></View>;
  if (error) return <Text style={styles.messageLimitNotice}>{error}</Text>;
  if (!hasMore) return <Text style={styles.messageLimitNotice}>没有更早的消息了</Text>;
  // 第一页不满一屏时滑不动，给个按钮
  return (
    <Pressable accessibilityRole="button" onPress={onLoad} style={({ pressed }) => [styles.groupHistoryHead, pressed && styles.pressed, webPointer]} testID="chat-group-older">
      <Text style={[styles.messageLimitNotice, styles.groupHistoryLink]}>往上滑或点这里加载更早的消息</Text>
    </Pressable>
  );
}

function GroupSummary({ row, privacy }: { row: ChatConversationRow; privacy: boolean }) {
  return (
    <ScrollView contentContainerStyle={styles.groupSummaryContent} showsVerticalScrollIndicator={false}>
      <View {...ws("w-emptyicon")} style={[styles.groupSummaryIcon, { backgroundColor: alpha(row.accent, 0.16) }]}>
        <UsersRound color={row.accent} size={30} strokeWidth={1.7} />
      </View>
      <Text {...ws("w-emptytitle")} style={styles.groupSummaryTitle}>{privacy ? "群聊" : row.name}</Text>
      <Text style={styles.groupSummaryBody}>群聊正文不会落盘，这里只展示采集到的统计信息。</Text>
      <View style={styles.groupFacts}>
        <ChatFact label="已采集消息" value={formatCount(row.messageCount)} />
        <ChatFact label="本人发言" value={formatCount(row.ownMessageCount)} />
        <ChatFact label="可读正文" value="0" />
      </View>
      <View {...ws("stamp-bar")} style={styles.groupPrivacyNote}>
        <ShieldCheck color={color.green} size={16} strokeWidth={2} />
        <Text style={styles.groupPrivacyNoteText}>为保护群聊成员隐私，群聊正文从采集边界开始即被丢弃。</Text>
      </View>
    </ScrollView>
  );
}

function ChatFact({ label, value }: { label: string; value: string }) {
  return (
    <View {...ws("c-fact")} style={styles.chatFact}>
      <Text {...ws("c-factvalue")} style={styles.chatFactValue}>{value}</Text>
      <Text style={styles.chatFactLabel}>{label}</Text>
    </View>
  );
}

function SparkBoard({
  live,
  mobile,
  now,
  onBack,
  onOpen,
  privacy,
  rows,
  sparks,
  sendBlock,
  sendConnection,
  selfId,
  targets,
  videos,
}: {
  live: boolean;
  mobile: boolean;
  now: Date;
  onBack: () => void;
  onOpen: (row: ChatConversationRow) => void;
  privacy: boolean;
  rows: ChatConversationRow[];
  sparks: Spark[];
  sendBlock: string | null;
  sendConnection: ChatSendConnection | null;
  /** 续火花能选的对象：所有会话，好友和群都算，有没有火花都能发 */
  targets: ChatConversationRow[];
  selfId: string | null;
  videos: PersonalVideoRecord[];
}) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const alive = sparks.filter((spark) => spark.state === "pending" || spark.state === "done");
  // 已按天数从长到短排好，lit[0] 就是最久的一簇；抖音给的天数本身就是亮着的
  const lit = alive.filter((spark) => spark.official !== undefined || spark.days >= SPARK_LIT_DAYS);
  const waiting = lit.filter((spark) => spark.state === "pending").length;
  // 没点亮的单独一组，免得「今天还没续」的组内条数和上面的数字对不上
  const sections = [
    { title: "今天还没续", items: lit.filter((spark) => spark.state === "pending") },
    { title: "今天续上了", items: lit.filter((spark) => spark.state === "done") },
    { title: "重燃中", items: sparks.filter((spark) => spark.state === "recover") },
    { title: "快点亮了", items: alive.filter((spark) => !lit.includes(spark)) },
    { title: "最近断了", items: sparks.filter((spark) => spark.state === "broken") },
  ].filter((section) => section.items.length > 0);
  const reigniting = sparks.filter((spark) => spark.state === "recover").length;
  const summary = waiting ? `离今天结束还有 ${formatTimeLeft(now)}，${waiting} 个火花还没续${reigniting ? `，另有 ${reigniting} 个在重燃` : ""}。`
    : reigniting ? `${reigniting} 个火花在重燃，每天都聊上才能重新点亮。`
    : lit.length ? "亮着的火花今天都续上了。"
      : alive.length ? `还没有点亮的火花，连着聊满 ${SPARK_LIT_DAYS} 天就会亮起来。`
        : "最近没有连着聊天的好友。";
  let order = 0;

  // 续火花：勾选对象、选好内容，一个一个发出去；看板关掉就停。
  const [renewing, setRenewing] = useState(false);
  const [draft] = useState(loadRenewDraft);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // 发送在看板外面跑（sparkRenewJob），关掉看板也接着发
  const run = useSyncExternalStore(sparkRenewJob.subscribe, sparkRenewJob.snapshot);
  const progress = run?.progress ?? {};
  const running = run?.running ?? false;
  // 「今天还没续、而且今天你还没发过」的火花；已经发过的只能等对方回
  const unrenewed = () => new Set(sparks.filter((spark) => (spark.state === "pending" && spark.today !== "mine") || spark.state === "recover").map((spark) => spark.id));
  // 打开时沿用上次发过的对象（每天续的多半是同一批），第一次用才按火花来勾
  const initialPick = () => {
    const known = new Set(targets.map((row) => row.id));
    const last = draft?.picked.filter((id) => known.has(id)) ?? [];
    return last.length ? new Set(last) : unrenewed();
  };
  const toggle = (id: string) => setPicked((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const start = (payload: SparkPayload, content: Omit<RenewDraft, "picked">) => {
    if (!sendConnection || running) return;
    const ids = targets.map((row) => row.id).filter((id) => picked.has(id));
    saveRenewDraft({ ...content, picked: ids });
    sparkRenewJob.start(sendConnection, ids, payload, selfId);
  };

  return (
    <View {...fx({ motion: "fade" })} style={[styles.detailPane, mobile && styles.detailPaneMobile]} testID="chat-spark-board">
      <View {...ws("c-dhead")} style={styles.detailHeader}>
        {mobile ? (
          <Pressable accessibilityLabel="返回聊天列表" accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.detailBackButton, pressed && styles.pressed, webPointer]}>
            <ChevronLeft color={color.textSecondary} size={21} strokeWidth={2} />
          </Pressable>
        ) : null}
        <View style={styles.detailHeaderCopy}>
          <Text {...ws("c-dtitle")} style={styles.detailTitle}>火花</Text>
          <Text style={styles.detailMeta}>{summary}</Text>
        </View>
        <Pressable
          accessibilityLabel={renewing ? "收起续火花" : "一键续火花"}
          accessibilityRole="button"
          aria-expanded={renewing}
          onPress={() => {
            if (!renewing) setPicked(initialPick());
            setRenewing(!renewing);
          }}
          {...ws("btn small", renewing && "on")}
          style={({ pressed }) => [styles.receptionButton, renewing && styles.sparkRenewToggleOn, pressed && styles.pressed, webPointer]}
          testID="chat-spark-renew-toggle"
        >
          <Flame color={color.amber} fill={renewing ? color.amber : "none"} size={13} strokeWidth={2} />
          <Text style={styles.receptionButtonText}>一键续火花</Text>
        </Pressable>
        {!mobile ? (
          <Pressable accessibilityLabel="关闭火花看板" accessibilityRole="button" {...fx({ hover: "raise", ws: "btn square" })} onPress={onBack} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, webPointer]}>
            <X color={color.textSecondary} size={17} />
          </Pressable>
        ) : null}
      </View>

      {!live ? (
        <View {...ws("stamp-bar")} style={[styles.privacyNotice, styles.sparkNotice]}>
          <Pause color={color.amber} size={14} strokeWidth={2} />
          <Text style={[styles.privacyNoticeText, styles.sparkNoticeText]}>现在没有在接收新消息，今天的情况可能还没更新。</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.sparkContent} showsVerticalScrollIndicator={false}>
        {renewing ? (
          <SparkRenewPanel
            blocked={sendBlock}
            draft={draft}
            onClear={() => setPicked(new Set())}
            onPick={(ids) => setPicked(new Set(ids))}
            onPickUnrenewed={unrenewed().size ? () => setPicked(unrenewed()) : null}
            onStart={start}
            onStop={sparkRenewJob.stop}
            onToggle={toggle}
            picked={picked}
            privacy={privacy}
            progress={progress}
            running={running}
            sparks={sparks}
            targets={targets}
            videos={videos}
          />
        ) : null}

        <View style={styles.sparkFacts}>
          <ChatFact label="亮着的火花" value={formatCount(lit.length)} />
          <ChatFact label="今天还没续" value={formatCount(waiting)} />
          <ChatFact label="最久的火花" value={lit[0] ? `${lit[0].days} 天` : "—"} />
        </View>

        {sections.length ? sections.map((section) => (
          <View key={section.title} style={styles.sparkSection}>
            <View style={styles.sparkSectionHead}>
              <Text {...ws("c-sectiontitle")} style={styles.sparkSectionTitle}>{section.title}</Text>
              <Text style={styles.sparkSectionCount}>{section.items.length}</Text>
            </View>
            <View {...ws("c-sparklist")} style={styles.sparkList}>
              {section.items.map((spark, index) => {
                const row = byId.get(spark.id);
                order += 1;
                return row ? (
                  <SparkRow first={index === 0} i={Math.min(order, 16)} key={spark.id} mobile={mobile} now={now} onPress={() => onOpen(row)} privacy={privacy} row={row} spark={spark} />
                ) : null;
              })}
            </View>
          </View>
        )) : (
          <View {...fx({ motion: "rise" })} style={styles.sparkEmpty}>
            <View {...ws("w-emptyicon")} style={[styles.emptyChatIcon, styles.sparkEmptyIcon]}><Flame color={color.amber} size={25} strokeWidth={1.8} /></View>
            <Text {...ws("w-emptytitle small")} style={styles.detailEmptyTitle}>还没有火花</Text>
            <Text style={styles.listEmptyBody}>{rows.length ? "和好友连着几天互相发消息，这里就会开始计天数。" : "连接采集器读取聊天后，这里会显示你和好友的火花。"}</Text>
          </View>
        )}

        <Text style={styles.sparkNote}>
          {sparks.some((spark) => spark.official !== undefined) ? "亮着的和重燃中的火花是抖音自己的数据，接收消息时每 5 分钟刷新一次。" : ""}
          「快点亮了」「最近断了」按本机保存的聊天记录估算：同一天你们都发过消息才算一天，连着聊满 {SPARK_LIT_DAYS} 天会点亮火花。抖音没有公开它的算法，以抖音里显示的为准。
          {mobile ? "" : "右边的小方格是最近两周，实心表示那天你们都发过消息，浅色表示只有一方发过。"}
        </Text>
      </ScrollView>
    </View>
  );
}

const SPARK_KINDS = [["text", "一句话"], ["emoji", "表情"], ["video", "视频"]] as const;
const SPARK_EMOJI_DEFAULT = CHAT_EMOJI.some(([code]) => code === "[续火花吧]") ? "[续火花吧]" : CHAT_EMOJI[0]?.[0] ?? "";
const sparkStateLabel: Record<SparkSendState, string> = {
  waiting: "排队中", sending: "发送中", sent: "已发送", failed: "没发出去", unknown: "待确认", skipped: "没发",
};

// 粘贴的链接或作品 ID 变成一条只够分享用的视频记录；短链接要先在浏览器里打开拿到完整地址。
function videoFromLink(value: string): PersonalVideoRecord | null {
  const id = /^(?:https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/)?(\d{15,30})(?:[/?#].*)?$/u.exec(value.trim())?.[1];
  return id ? { id: `link:${id}`, title: "粘贴的视频", author: null, occurredAt: null, url: `https://www.douyin.com/video/${id}`, videoId: id, mediaType: "video" } : null;
}

function renewReport(progress: Record<string, SparkSendUpdate>, running: boolean): string | null {
  const results = Object.values(progress);
  if (!results.length) return null;
  const tally = (state: SparkSendState) => results.filter((item) => item.state === state).length;
  const done = results.length - tally("waiting") - tally("sending");
  return running ? `正在发第 ${Math.min(done + 1, results.length)} 个，共 ${results.length} 个。`
    : [`这一轮 ${tally("sent")} 个已发送`, tally("failed") && `${tally("failed")} 个没发出去`, tally("unknown") && `${tally("unknown")} 个待确认`, tally("skipped") && `${tally("skipped")} 个没发`].filter(Boolean).join("，") + "。";
}

// 聊天页顶上的一条进度：看板关了也看得到，发着的时候能停下，发完能收起。
function SparkRenewStatus({ run }: { run: SparkRenewRun }) {
  return (
    <View style={styles.renewStatus} testID="chat-spark-renew-status">
      <Flame color={color.amber} fill={run.running ? color.amber : "none"} size={12} strokeWidth={2} />
      <Text accessibilityLiveRegion="polite" numberOfLines={1} style={styles.renewStatusText}>续火花：{renewReport(run.progress, run.running)}</Text>
      <Pressable accessibilityLabel={run.running ? "停下续火花" : "收起续火花结果"} accessibilityRole="button" onPress={run.running ? sparkRenewJob.stop : sparkRenewJob.dismiss}
        {...ws("btn small")} style={({ pressed }) => [styles.receptionButton, pressed && styles.pressed, webPointer]} testID="chat-spark-renew-status-action">
        {run.running ? <Pause color={color.textSecondary} size={13} /> : <X color={color.textSecondary} size={13} />}
        <Text style={styles.receptionButtonText}>{run.running ? "停下" : "收起"}</Text>
      </Pressable>
    </View>
  );
}

const RENEW_DRAFT_KEY = "content-insights.spark-renew";
type RenewDraft = { picked: string[]; kind: (typeof SPARK_KINDS)[number][0]; text: string; emoji: string };
// 只是本机的使用习惯（上次发给谁、发什么），读写失败就当第一次用
function loadRenewDraft(): RenewDraft | null {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(RENEW_DRAFT_KEY) ?? "null");
    return value && Array.isArray(value.picked) && SPARK_KINDS.some(([kind]) => kind === value.kind) ? value : null;
  } catch { return null; }
}
function saveRenewDraft(draft: RenewDraft) {
  try { globalThis.localStorage?.setItem(RENEW_DRAFT_KEY, JSON.stringify(draft)); } catch { /* 存不下就下次重选 */ }
}
const sparkSummary = (spark: Spark) => spark.state === "recover" ? `${spark.days} 天，${spark.official}` : spark.state === "broken" ? `断了，之前 ${spark.days} 天`
  : spark.state === "done" ? `${spark.days} 天，今天续上了` : spark.today === "mine" ? `${spark.days} 天，你今天发过了` : `${spark.days} 天，今天还没续`;

function SparkRenewPanel({ blocked, draft, onClear, onPick, onPickUnrenewed, onStart, onStop, onToggle, picked, privacy, progress, running, sparks, targets, videos }: {
  blocked: string | null;
  draft: RenewDraft | null;
  onClear: () => void;
  onPick: (ids: string[]) => void;
  onPickUnrenewed: (() => void) | null;
  onStart: (payload: SparkPayload, content: Omit<RenewDraft, "picked">) => void;
  onStop: () => void;
  onToggle: (id: string) => void;
  picked: ReadonlySet<string>;
  privacy: boolean;
  progress: Record<string, SparkSendUpdate>;
  running: boolean;
  sparks: Spark[];
  targets: ChatConversationRow[];
  videos: PersonalVideoRecord[];
}) {
  const [kind, setKind] = useState<RenewDraft["kind"]>(draft?.kind ?? "text");
  const [text, setText] = useState(draft?.text ?? "");
  const [emoji, setEmoji] = useState(draft?.emoji && CHAT_EMOJI.some(([code]) => code === draft.emoji) ? draft.emoji : SPARK_EMOJI_DEFAULT);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [query, setQuery] = useState("");
  const sparkById = new Map(sparks.map((spark) => [spark.id, spark]));
  const keyword = query.trim().toLocaleLowerCase("zh-CN");
  const shown = keyword && !privacy ? targets.filter((row) => row.name.toLocaleLowerCase("zh-CN").includes(keyword)) : targets;
  const linked = link.trim() ? videoFromLink(link) : null;
  const video = link.trim() ? linked : videos.find((item) => item.id === videoId) ?? null;
  const payload: SparkPayload | null = kind === "text" ? (text.trim() ? { kind: "text", text: text.trim() } : null)
    : kind === "emoji" ? (emoji ? { kind: "text", text: emoji } : null)
      : video ? { kind: "video", record: video } : null;
  const count = picked.size;
  const report = renewReport(progress, running);
  const capped = count > MAX_SPARK_BATCH;
  const reason = blocked ?? (!count ? "先在上面勾选要发给谁" : capped ? `一次最多发 ${MAX_SPARK_BATCH} 个` : !payload ? kind === "video" && link.trim() ? "这个链接认不出来，粘贴 douyin.com/video/ 开头的链接或作品 ID" : "先选好要发的内容" : null);

  return (
    <View {...ws("c-sparklist")} style={styles.renewPanel} testID="chat-spark-renew">
      <View style={styles.renewLine}>
        <Text style={styles.renewLabel}>发给谁</Text>
        <Text style={styles.renewCount}>已选 {count} 个</Text>
        <View style={styles.renewChips}>
          {([onPickUnrenewed ? ["今天没续的火花", onPickUnrenewed] : null, ["全选", () => onPick(shown.map((row) => row.id))], ["清空", onClear]].filter(Boolean) as Array<[string, () => void]>).map(([label, action]) => (
            <Pressable accessibilityRole="button" disabled={running} key={label} onPress={action} {...ws("btn small")} style={({ pressed }) => [styles.receptionButton, pressed && styles.pressed, running && styles.composerDisabled, webPointer]}>
              <Text style={styles.receptionButtonText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextInput accessibilityLabel="搜索好友或群聊" editable={!running} onChangeText={setQuery} placeholder="搜索好友或群聊"
        placeholderTextColor={color.textMuted} {...ws("c-input")} style={[styles.composerInput, styles.renewInput]} value={query} />
      <ScrollView style={styles.renewTargets} testID="chat-spark-targets">
        {shown.map((row, index) => {
          const spark = sparkById.get(row.id);
          const update = progress[row.id];
          const checked = picked.has(row.id);
          const note = update?.message && update.state !== "sent" ? update.message
            : spark ? sparkSummary(spark) : row.kind === "group" ? "群聊" : "好友";
          return (
            <Pressable accessibilityLabel={`${privacy ? (row.kind === "group" ? "群聊" : "好友") : row.name}，${note}`} accessibilityRole="checkbox" aria-checked={checked} disabled={running} key={row.id} onPress={() => onToggle(row.id)}
              style={({ pressed }) => [styles.renewTarget, index > 0 && styles.sparkRowDivided, pressed && styles.pressed, webPointer]}>
              <View style={[styles.renewCheck, checked && styles.renewCheckOn]}>{checked ? <Check color={color.canvas} size={12} strokeWidth={3} /> : null}</View>
              <ChatAvatar accent={row.accent} avatarUrl={row.avatarUrl} initials={row.initials} kind={row.kind} privacy={privacy} size={28} />
              <View style={styles.sparkCopy}>
                <Text numberOfLines={1} style={styles.renewTargetName}>{privacy ? (row.kind === "group" ? "群聊" : "好友") : row.name}</Text>
                <View style={styles.renewTargetNote}>
                  {spark && !update ? <Flame color={spark.state === "broken" ? color.textMuted : color.amber} size={10} strokeWidth={2} /> : null}
                  <Text numberOfLines={1} style={styles.renewHint}>{note}</Text>
                </View>
              </View>
              {update ? <Text style={[styles.sparkLeft, styles[`renew_${update.state}`]]}>{sparkStateLabel[update.state]}</Text> : null}
            </Pressable>
          );
        })}
        {!shown.length ? <Text style={[styles.renewHint, styles.renewEmpty]}>{targets.length ? "没有搜到这个名字" : "还没有聊天会话，先连接采集器读取聊天。"}</Text> : null}
      </ScrollView>

      <View style={styles.renewLine}>
        <Text style={styles.renewLabel}>发什么</Text>
        <View accessibilityRole="tablist" style={styles.renewTabs}>
          {SPARK_KINDS.map(([value, label]) => (
            <Pressable accessibilityRole="tab" aria-selected={kind === value} disabled={running} key={value} onPress={() => setKind(value)}
              {...ws("btn small", kind === value && "on")} style={({ pressed }) => [styles.receptionButton, kind === value && styles.renewTabOn, pressed && styles.pressed, webPointer]}>
              <Text style={[styles.receptionButtonText, kind === value && styles.renewTabTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {kind === "text" ? (
        <TextInput accessibilityLabel="要发的话" editable={!running} maxLength={500} multiline onChangeText={setText} placeholder="想说的话，比如：早呀，今天也续上"
          placeholderTextColor={color.textMuted} {...ws("c-input")} style={[styles.composerInput, styles.renewInput, webAutoHeight]} value={text} />
      ) : kind === "emoji" ? (
        <ScrollView contentContainerStyle={styles.emojiGrid} style={styles.renewEmoji} testID="chat-spark-emoji">
          {CHAT_EMOJI.map(([code, url]) => (
            <Pressable accessibilityLabel={code} accessibilityRole="button" aria-pressed={emoji === code} disabled={running} key={code} onPress={() => setEmoji(code)}
              style={({ pressed }) => [styles.emojiCell, emoji === code && styles.renewPicked, pressed && styles.pressed, webPointer]}>
              <Image source={{ uri: url }} style={styles.emojiImage} />
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.renewVideos}>
          {videos.length ? (
            <ScrollView contentContainerStyle={styles.renewVideoRow} horizontal showsHorizontalScrollIndicator={false}>
              {videos.map((item) => (
                <Pressable accessibilityLabel={`发送视频：${item.title}`} accessibilityRole="button" aria-pressed={!link.trim() && videoId === item.id} disabled={running} key={item.id}
                  onPress={() => { setVideoId(item.id); setLink(""); }} style={({ pressed }) => [styles.renewVideo, !link.trim() && videoId === item.id && styles.renewPicked, pressed && styles.pressed, webPointer]}>
                  {item.coverUrl ? <Image resizeMode="cover" source={{ uri: item.coverUrl }} style={styles.renewCover} /> : <View style={[styles.renewCover, styles.renewCoverEmpty]}><Video color={color.textMuted} size={18} /></View>}
                  <Text numberOfLines={2} style={styles.renewVideoTitle}>{renderEmojiText(item.title, 12)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : <Text style={styles.renewHint}>还没有喜欢或收藏的视频，可以直接粘贴链接。</Text>}
          <TextInput accessibilityLabel="视频链接" editable={!running} onChangeText={setLink} placeholder="或者粘贴抖音视频链接 / 作品 ID"
            placeholderTextColor={color.textMuted} {...ws("c-input")} style={[styles.composerInput, styles.renewInput]} value={link} />
          <Text style={styles.renewHint}>视频只能发给抖音分享面板最上面、不用往下翻就看得到的那几位，其他人会跳过（往下翻会让抖音给沿路的人都建会话）。一句话和表情不受这个限制。</Text>
        </View>
      )}

      <View style={styles.renewFooter}>
        <Text accessibilityLiveRegion="polite" style={[styles.renewHint, styles.renewReport]}>{report ?? reason ?? `会给 ${count} 个对象各发一条，发完一个隔几秒再发下一个。`}</Text>
        {running ? (
          <Pressable accessibilityRole="button" onPress={onStop} {...ws("btn small")} style={({ pressed }) => [styles.receptionButton, pressed && styles.pressed, webPointer]} testID="chat-spark-renew-stop">
            <Pause color={color.textSecondary} size={13} />
            <Text style={styles.receptionButtonText}>停下</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" aria-disabled={Boolean(reason)} disabled={Boolean(reason)} onPress={() => payload && onStart(payload, { kind, text, emoji })}
            {...ws("btn-solid", !reason && "on")} style={({ pressed }) => [styles.renewStart, reason && styles.composerDisabled, pressed && styles.pressed, webPointer]} testID="chat-spark-renew-start">
            <Flame color={color.canvas} fill={color.canvas} size={13} strokeWidth={2} />
            <Text style={styles.renewStartText}>发给 {Math.min(count, MAX_SPARK_BATCH)} 个对象</Text>
          </Pressable>
        )}
      </View>
      {report && reason && !running ? <Text style={styles.renewHint}>{reason}</Text> : null}
      <Text style={styles.renewNote}>短时间给很多人发一样的内容，抖音可能会限制发送，别一天连着点好几轮。群里发的消息不会存到本机。</Text>
    </View>
  );
}

function SparkRow({
  first,
  i,
  mobile,
  now,
  onPress,
  privacy,
  row,
  spark,
}: {
  first: boolean;
  i: number;
  mobile: boolean;
  now: Date;
  onPress: () => void;
  privacy: boolean;
  row: ChatConversationRow;
  spark: Spark;
}) {
  const name = privacy ? (row.kind === "group" ? "群聊" : "好友") : row.name;
  const burning = spark.state === "pending" || spark.state === "done" ? spark.official !== undefined || spark.days >= SPARK_LIT_DAYS : false;
  const status = sparkStatus(spark, now);
  const countdown = burning && spark.state === "pending";
  return (
    <Pressable
      {...fx({ motion: "rise", i, hover: "tint" })}
      accessibilityLabel={`${name}，${spark.state === "broken" ? "之前" : ""}连着聊了 ${spark.days} 天，${status}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.sparkRow, !first && styles.sparkRowDivided, pressed && styles.pressed, webPointer]}
      testID={`chat-spark-${row.id}`}
    >
      <ChatAvatar accent={row.accent} avatarUrl={row.avatarUrl} initials={row.initials} kind={row.kind} privacy={privacy} size={40} />
      <View style={styles.sparkCopy}>
        <Text numberOfLines={1} style={styles.sparkName}>{name}</Text>
        <Text numberOfLines={2} style={styles.sparkStatus}>{status}</Text>
      </View>
      {!mobile && spark.recent.length ? <SparkStrip days={spark.recent} /> : null}
      <View style={styles.sparkCount}>
        <View style={styles.sparkDays}>
          <Flame color={burning ? color.amber : color.textMuted} fill={burning ? color.amber : "none"} size={14} strokeWidth={2} />
          <Text {...ws("c-sparkdays")} style={[styles.sparkDaysValue, !burning && styles.sparkDaysMuted]}>{spark.days}</Text>
          <Text style={styles.sparkDaysUnit}>天</Text>
        </View>
        {countdown ? <Text style={[styles.sparkLeft, msUntilMidnight(now) < 3 * 3_600_000 && styles.sparkLeftUrgent]}>还剩 {formatTimeLeft(now)}</Text> : null}
      </View>
    </Pressable>
  );
}

function SparkStrip({ days }: { days: SparkDay[] }) {
  return (
    <View style={styles.sparkStrip}>
      {days.map((day, index) => (
        <View key={index} style={[styles.sparkCell, day === "both" ? styles.sparkCellBoth : day !== "none" && styles.sparkCellHalf]} />
      ))}
    </View>
  );
}

const pendingSparkStatus: Record<SparkDay, string> = {
  theirs: "对方今天发过消息了，就等你回。",
  mine: "你今天发过了，还在等对方回。",
  one: "今天只有一方发过消息。",
  none: "今天你们还没聊过。",
  both: "今天已经续上了。",
};

function sparkStatus(spark: Spark, now: Date): string {
  if (spark.state === "recover") return `抖音显示「${spark.official}」，每天都聊上才能重新点亮。`;
  if (spark.official !== undefined) {
    if (spark.state === "done") return "今天已经续上了。";
    return spark.recent.length ? pendingSparkStatus[spark.today] : "今天还没续上。";
  }
  if (spark.state === "broken") return `${sparkDayLabel(spark.brokeOn, now)}没接上，之前连着聊了 ${spark.days} 天。`;
  const needed = SPARK_LIT_DAYS - spark.days;
  if (spark.state === "done") return needed > 0 ? `再聊 ${needed} 天就能点亮。` : "今天已经续上了。";
  if (needed === 1) return "今天聊上就能点亮。";
  if (needed > 1) return `从今天起连着聊 ${needed} 天就能点亮。`;
  return pendingSparkStatus[spark.today];
}

function sparkDayLabel(key: string | null, now: Date): string {
  if (key === sparkDayKey(shiftDay(now, -1))) return "昨天";
  if (key === sparkDayKey(shiftDay(now, -2))) return "前天";
  const [, month, day] = key?.split("-") ?? [];
  return month && day ? `${Number(month)} 月 ${Number(day)} 日` : "那天";
}

// 倒计时和跨零点都靠它：每分钟换一次 now，火花状态跟着重算。
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function msUntilMidnight(now: Date): number {
  return shiftDay(now, 1).setHours(0, 0, 0, 0) - now.getTime();
}

function formatTimeLeft(now: Date): string {
  const minutes = Math.max(1, Math.ceil(msUntilMidnight(now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function ConversationDateDivider() {
  return <Text {...ws("mono")} style={styles.dateDivider}>本地聊天快照 · 由采集时间整理</Text>;
}

function MessageListEmpty({ privacy }: { privacy: boolean }) {
  return (
    <View {...fx({ motion: "rise" })} style={styles.messageEmptyState}>
      <MessageCircle color={color.textMuted} size={24} strokeWidth={1.6} />
      <Text style={styles.messageEmptyText}>{privacy ? "消息正文已隐藏" : "这个会话没有可显示的正文"}</Text>
    </View>
  );
}

function ChatMessageBubble({
  i = 0,
  message,
  onOpenRecord,
  privacy,
  row,
  selfId,
}: {
  i?: number;
  message: ChatMessage;
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
  row: ChatConversationRow;
  selfId: string | null;
}) {
  if (message.type === "system") {
    return <Text {...ws("stamp-ghost c-system")} style={styles.systemMessage}>{privacy ? "系统消息已隐藏" : chatPreview(message)}</Text>;
  }
  const own = !privacy && isOwnMessage(message, selfId);
  const sender = privacy ? "好友" : cleanText(message.senderName) ?? (own ? "我" : "对方");
  // Image stickers already carry their own visual surface. Keep the message
  // column/timestamp layout, but remove the generic chat-bubble background and
  // padding so the sticker is shown on its own.
  const framelessSticker = !privacy && message.type === "sticker" && Boolean(message.mediaUrl);
  return (
    <View {...fx({ motion: "rise", i })} style={[styles.messageLine, own && styles.messageLineOwn]}>
      {!own ? <ChatAvatar avatarUrl={message.senderAvatarUrl ?? row.avatarUrl} accent={row.accent} initials={initialsFor(sender, "friend")} kind="friend" privacy={privacy} size={30} /> : null}
      <View style={[styles.messageColumn, own && styles.messageColumnOwn]}>
        {!own ? <Text style={styles.senderLabel}>{sender}</Text> : null}
        <View {...ws("c-bubble", framelessSticker ? "sticker" : own ? "own" : "in")} style={[styles.bubble, framelessSticker ? styles.bubbleSticker : own ? styles.bubbleOwn : styles.bubbleIncoming]}>
          {privacy ? <Text style={styles.bubbleText}>消息内容已隐藏</Text> : <MessageContent message={message} onOpenRecord={onOpenRecord} />}
        </View>
        <Text {...ws("mono")} style={[styles.messageTime, own && styles.messageTimeOwn]}>{formatMessageTime(message.sentAt)}</Text>
      </View>
      {own ? <ChatAvatar accent={color.cyan} initials="我" kind="friend" size={30} /> : null}
    </View>
  );
}

export function MessageContent({ message, onOpenRecord }: { message: ChatMessage; onOpenRecord: (url: string) => Promise<void> }) {
  if (message.type === "comment") {
    const comment = message.comment;
    const video = message.share;
    const sourceName = comment?.sourceType === "image" ? "图文" : comment?.sourceType === "video" ? "视频" : "作品";
    const source = (
      <View style={styles.commentSource}>
        {video?.coverUrl ? <View style={styles.commentCoverFrame}><Image accessibilityLabel={`评论来源${sourceName}封面`} resizeMode="cover" source={{ uri: video.coverUrl }} style={styles.commentCover} />{comment?.sourceType === "video" ? <View pointerEvents="none" style={styles.commentPlay}><Play size={17} fill="#ffffff" color="#ffffff" /></View> : null}</View> : null}
        <View style={styles.commentSourceCopy}>
          <Text style={styles.commentSourceLabel}>来自{sourceName}</Text>
          <Text numberOfLines={2} style={styles.commentSourceTitle}>{video?.title ?? (video?.url ? `查看原${sourceName}` : `原${sourceName}信息未提供`)}</Text>
        </View>
      </View>
    );
    return (
      <View style={styles.commentCard} testID="chat-comment-card">
        <Text style={styles.commentAttribution}>{comment?.author ? `分享 @${comment.author} 的评论` : "分享评论"}</Text>
        {comment?.text || message.text ? <Text numberOfLines={2} style={styles.commentText}>{comment?.text ?? message.text}</Text> : null}
        {comment?.mediaUrl && comment.mediaType !== "video" ? <Image accessibilityLabel="评论图片" resizeMode="contain" source={{ uri: comment.mediaUrl }} style={styles.commentImage} /> : null}
        {comment?.mediaType === "video" ? <Text style={styles.commentHint}>视频评论 · 请在原{sourceName}中查看</Text>
          : !comment?.text && !message.text && !comment?.mediaUrl ? <Text style={styles.commentHint}>评论内容未提供</Text> : null}
        {video?.url ? <Pressable accessibilityLabel={`打开评论来源${sourceName}`} accessibilityRole="link" onPress={() => void onOpenRecord(video.url!)} style={({ pressed }) => [pressed && styles.pressed, webPointer]}>{source}</Pressable> : source}
      </View>
    );
  }
  if (message.type === "image" && message.mediaUrl) {
    return (
      <Image accessibilityLabel="聊天图片" resizeMode="cover" source={{ uri: message.mediaUrl }} style={styles.messageImage} />
    );
  }
  if (message.type === "share" && message.share) {
    const share = message.share;
    // Older snapshots can contain a share-shaped object with only the text
    // title. It is not enough evidence for a media card, so keep it in the
    // ordinary text-bubble path instead of showing a misleading play button.
    if (!hasChatShareEvidence(share)) {
      const text = message.text && !/^\[分享\]$/u.test(message.text) ? message.text : share.title;
      return <Text style={styles.bubbleText}>{renderEmojiText(text ?? "文字消息")}</Text>;
    }
    const card = (
      <View style={styles.shareCard}>
        {share.coverUrl ? <Image accessibilityLabel="分享内容封面" resizeMode="cover" source={{ uri: share.coverUrl }} style={styles.shareCover} /> : <View style={styles.shareCoverFallback}><Play color={color.cyan} fill={color.cyan} size={18} /></View>}
        <View style={styles.shareCopy}>
          <Text numberOfLines={2} style={styles.shareTitle}>{share.title ?? "分享了一条视频"}</Text>
          {share.author ? <Text numberOfLines={1} style={styles.shareAuthor}>{share.author}</Text> : null}
          <Text style={styles.shareLabel}>抖音分享</Text>
        </View>
      </View>
    );
    return share.url ? (
      <Pressable accessibilityLabel="打开分享的视频" accessibilityRole="link" onPress={() => void onOpenRecord(share.url!)} style={({ pressed }) => [pressed && styles.pressed, webPointer]}>
        {card}
      </Pressable>
    ) : card;
  }
  if (message.type === "call" || message.type === "voice" || message.type === "video") {
    const CallIcon = message.type === "video" ? Video : message.type === "voice" ? Mic : Phone;
    return (
      <View style={styles.callMessage}>
        <View style={styles.callIcon}><CallIcon color={color.cyan} size={17} strokeWidth={2} /></View>
        <View style={styles.callCopy}>
          <Text style={styles.callTitle}>{message.type === "video" ? "视频通话" : message.type === "voice" ? "语音消息" : "通话记录"}</Text>
          <Text style={styles.callMeta}>{message.callDurationSeconds === null ? "时长未提供" : formatDuration(message.callDurationSeconds)}</Text>
        </View>
      </View>
    );
  }
  if (message.type === "sticker") {
    if (message.mediaUrl) {
      return (
        <Image
          accessibilityLabel="聊天表情包"
          resizeMode="contain"
          source={{ uri: message.mediaUrl }}
          style={styles.stickerImage}
        />
      );
    }
    return <Text style={styles.stickerText}>{renderEmojiText(message.text && !/^\[表情包\]$/u.test(message.text) ? message.text : "表情包")}</Text>;
  }
  if (message.type === "image") {
    return <View style={styles.attachmentFallback}><ImageIcon color={color.cyan} size={17} /><Text style={styles.attachmentText}>图片消息</Text></View>;
  }
  if (message.type === "unknown" && !message.text) {
    return <View style={styles.attachmentFallback}><FileText color={color.textMuted} size={16} /><Text style={styles.attachmentText}>暂未解析的消息</Text></View>;
  }
  return <Text style={styles.bubbleText}>{renderEmojiText(message.text ?? chatPreview(message))}</Text>;
}

function ChatComposer({
  blockedReason,
  hidden,
  onSend,
  onSent,
  sentNotice,
}: {
  blockedReason: string | null;
  /** 隐私模式：不显示已经打好的字，草稿留着，关掉后还在 */
  hidden: boolean;
  onSend: (text: string) => Promise<ChatSendOutcome>;
  onSent: () => void;
  sentNotice?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "warn" | "error" | "ok"; text: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const blocked = blockedReason !== null;
  const canSend = !blocked && !sending && text.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setNotice(null);
    setEmojiOpen(false);
    try {
      const result = await onSend(text);
      if (result.outcome === "confirmed") {
        setText("");
        onSent();
        if (sentNotice) setNotice({ tone: "ok", text: sentNotice });
      } else {
        // 没发出去或结果不明时留着原文，由用户决定要不要重发
        setNotice({ tone: result.outcome === "unknown" ? "warn" : "error", text: result.message });
      }
    } catch (error) {
      const unconfirmed = error instanceof LocalCollectorError && error.code === CHAT_SEND_UNCONFIRMED;
      setNotice({ tone: unconfirmed ? "warn" : "error", text: error instanceof Error ? error.message : "消息没发出去，请稍后再试。" });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // 网页端的 TextInput 就是 textarea；失焦后它仍记着光标位置（onSelectionChange 打字时不触发，靠不住）
  const insertEmoji = (code: string) => {
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? start;
    const next = text.slice(0, start) + code + text.slice(end);
    if (next.length > CHAT_TEXT_LIMIT) return;
    setText(next);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange?.(start + code.length, start + code.length);
    });
  };

  return (
    <View {...ws("c-composer")} style={styles.composerWrap}>
      {notice ? (
        <View style={[styles.composerNotice, notice.tone === "warn" && styles.composerNoticeWarn, notice.tone === "ok" && styles.composerNoticeOk]} testID="chat-send-notice">
          <Text accessibilityLiveRegion="polite" style={[styles.composerNoticeText, notice.tone === "warn" && styles.composerNoticeTextWarn, notice.tone === "ok" && styles.composerNoticeTextOk]}>{notice.text}</Text>
          <Pressable accessibilityLabel="关闭提示" accessibilityRole="button" hitSlop={8} onPress={() => setNotice(null)} style={webPointer}>
            <X color={color.textMuted} size={13} />
          </Pressable>
        </View>
      ) : null}
      {emojiOpen && !blocked ? (
        <ScrollView contentContainerStyle={styles.emojiGrid} style={styles.emojiPanel} testID="chat-emoji-panel">
          {CHAT_EMOJI.map(([code, url]) => (
            <Pressable accessibilityLabel={code} accessibilityRole="button" key={code} onPress={() => insertEmoji(code)} style={({ pressed }) => [styles.emojiCell, pressed && styles.pressed, webPointer]}>
              <Image source={{ uri: url }} style={styles.emojiImage} />
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.composer}>
        <Pressable
          accessibilityLabel={emojiOpen ? "收起表情" : "插入表情"}
          accessibilityRole="button"
          accessibilityState={{ disabled: blocked, expanded: emojiOpen }}
          disabled={blocked}
          onPress={() => setEmojiOpen((open) => !open)}
          style={({ pressed }) => [styles.composerTool, emojiOpen && styles.composerToolActive, pressed && styles.pressed, blocked && styles.composerDisabled, webPointer]}
          testID="chat-emoji-toggle"
        >
          <Smile color={emojiOpen ? color.accent : color.textMuted} size={19} strokeWidth={1.8} />
        </Pressable>
        <TextInput
          accessibilityLabel="消息内容"
          editable={!blocked && !sending}
          maxLength={CHAT_TEXT_LIMIT}
          multiline
          onChangeText={setText}
          onKeyPress={(event) => {
            // 回车发送，Shift+回车换行；输入法选词时的回车不算
            const key = event.nativeEvent as unknown as KeyboardEvent;
            if (key.key !== "Enter" || key.shiftKey || key.isComposing || key.keyCode === 229) return;
            event.preventDefault();
            void submit();
          }}
          placeholder={blockedReason ?? "发消息（回车发送，Shift+回车换行）"}
          placeholderTextColor={color.textMuted}
          ref={inputRef}
          {...ws("c-input")}
          style={[styles.composerInput, webAutoHeight, blocked && styles.composerDisabled]}
          testID="chat-composer-input"
          value={hidden ? "" : text}
        />
        <Pressable
          accessibilityLabel={sending ? "正在发送" : "发送"}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSend, busy: sending }}
          disabled={!canSend}
          onPress={() => void submit()}
          {...ws("c-send", canSend && "on")}
          style={({ pressed }) => [styles.composerSend, canSend && styles.composerSendReady, pressed && styles.pressed, webPointer]}
          testID="chat-send-button"
        >
          {sending
            ? <ActivityIndicator color={color.textMuted} size="small" />
            : <Send color={canSend ? color.canvas : color.textMuted} size={17} strokeWidth={1.8} />}
        </Pressable>
      </View>
    </View>
  );
}

function ChatAvatar({
  accent,
  initials,
  kind,
  online = false,
  privacy = false,
  avatarUrl,
  size,
}: {
  accent: string;
  initials: string;
  kind: ChatConversationKind;
  online?: boolean;
  privacy?: boolean;
  avatarUrl?: string | null;
  size: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [avatarUrl]);
  const showImage = !privacy && !imageFailed && Boolean(safeChatAvatarUrl(avatarUrl));
  // 隐私模式下名字缩写也要藏：两个字的名字，缩写就是全名。
  return (
    <View {...ws("c-avatar")} style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(accent, 0.19) }]}>
      {showImage ? (
        <Image
          accessibilityLabel="联系人头像"
          onError={() => setImageFailed(true)}
          resizeMode="cover"
          source={{ uri: safeChatAvatarUrl(avatarUrl)! }}
          style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
        />
      ) : kind === "group" ? <UsersRound color={accent} size={Math.round(size * 0.45)} strokeWidth={1.8} /> : <Text style={[styles.avatarText, { color: accent, fontSize: Math.max(11, Math.round(size * 0.32)) }]}>{privacy ? "友" : initials}</Text>}
      {online ? <View {...fx({ motion: "pulse", ws: "dot on c-online" })} style={[styles.onlineDot, { width: Math.max(7, Math.round(size * 0.2)), height: Math.max(7, Math.round(size * 0.2)), borderRadius: size, borderColor: color.sidebar }]} /> : null}
    </View>
  );
}

function inferSelfId(messages: readonly ChatMessage[]): string | null {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const senderId = message.senderId?.trim();
    if (senderId) counts.set(senderId, (counts.get(senderId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first[1] < 2 || (second && first[1] < second[1] * 1.35)) return null;
  return first[0];
}

function isOwnMessage(message: ChatMessage, selfId: string | null): boolean {
  if (selfId && message.senderId === selfId) return true;
  return Boolean(message.senderName && /^(我|本人|自己)$/u.test(message.senderName.trim()));
}


function chatPreview(message: ChatMessage): string {
  const text = cleanText(message.text);
  if (message.type === "comment") return `[分享评论] ${cleanText(message.comment?.text) ?? text ?? (message.comment?.mediaType ? "评论附件" : "评论内容未提供")}`;
  if (text && !/^\[(?:图片|表情包|分享|通话)\]$/u.test(text)) return text;
  switch (message.type) {
    case "image": return "[图片]";
    case "sticker": return "[表情包]";
    case "share": return hasChatShareEvidence(message.share)
      ? message.share?.title ? `分享：${message.share.title}` : "[分享视频]"
      : message.share?.title ?? "文字消息";
    case "call": return "[通话]";
    case "voice": return "[语音]";
    case "video": return "[视频通话]";
    case "system": return text ?? "系统消息";
    case "unknown": return text ?? "暂未解析的消息";
    case "text": return text ?? "文字消息";
  }
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

const CHAT_AVATAR_HOST_SUFFIXES = [
  "douyin.com",
  "douyinpic.com",
  "douyinvod.com",
  "byteimg.com",
  "ibytedtos.com",
  "snssdk.com",
];

function safeChatAvatarUrl(value: string | null | undefined): string | null {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !CHAT_AVATAR_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function compareMessageTime(left: ChatMessage, right: ChatMessage): number {
  return messageTime(left.sentAt) - messageTime(right.sentAt) || left.id.localeCompare(right.id);
}

function messageTime(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatChatListTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatMessageTime(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

function initialsFor(name: string, kind: ChatConversationKind): string {
  if (kind === "group") return "群";
  const compact = name.replace(/\s+/gu, "").trim();
  if (!compact) return "友";
  const latin = compact.match(/[A-Za-z0-9]/gu);
  if (latin && latin.length >= 2) return `${latin[0]}${latin[1]}`.toUpperCase();
  return compact.slice(0, 2);
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

// ponytail: 与档案风一致的默认衬线字体，见 workspaceTheme
const bodyType = { fontFamily: font.body } as const;
function Text({ style, ...rest }: TextProps) {
  return <RNText {...rest} style={[bodyType, style]} />;
}

const styles = StyleSheet.create({
  workspace: { flex: 1, minWidth: 0, minHeight: 0 },
  receptionBar: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 16, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border, backgroundColor: color.sidebar },
  receptionCopy: { flex: 1, minWidth: 120, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 },
  receptionActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 6 },
  receptionDot: { width: 6, height: 6, borderRadius: 3 },
  receptionLabel: { color: color.textSecondary, fontSize: 11 },
  receptionProgress: { color: color.textMuted, fontSize: 10 },
  receptionError: { color: color.amber, fontSize: 10, flexShrink: 1 },
  receptionButton: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 9, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium },
  receptionButtonText: { color: color.textSecondary, fontSize: 10 },
  root: { flex: 1, flexDirection: "row", minWidth: 0, minHeight: 0, backgroundColor: color.canvas },
  rootMobile: { flexDirection: "column" },
  listPane: { width: 334, flexShrink: 0, minHeight: 0, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: color.border, backgroundColor: color.sidebar },
  listPaneMobile: { width: "100%", flex: 1, minHeight: 0, borderRightWidth: 0 },
  listHeader: { minHeight: 78, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  listHeaderCopy: { flex: 1, minWidth: 0 },
  chatTitle: { color: color.text, fontSize: 22, fontWeight: "900", letterSpacing: 0.2, fontFamily: font.serif },
  chatSubtitle: { color: color.textMuted, fontSize: 10, marginTop: 5 },
  iconButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium, backgroundColor: color.surface },
  searchBox: { height: 40, flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 14, marginTop: 14, paddingHorizontal: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  searchInput: { flex: 1, minWidth: 0, color: color.text, fontSize: 12, paddingVertical: 0 },
  searchClear: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  filterRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  filterTab: { height: 30, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, borderRadius: radius.small },
  filterTabActive: { backgroundColor: color.cyanSoft },
  filterTabText: { color: color.textMuted, fontSize: 11, fontWeight: "800" },
  filterTabTextActive: { color: color.cyan },
  filterTabCount: { color: color.textMuted, fontSize: 9, fontVariant: ["tabular-nums"] },
  filterTabCountActive: { color: color.cyan },
  conversationListContent: { paddingVertical: 5 },
  conversationListEmpty: { flexGrow: 1 },
  conversationItem: { position: "relative", minHeight: 82, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft },
  conversationItemSelected: { backgroundColor: color.surfaceRaised },
  conversationActiveMark: { position: "absolute", top: 19, bottom: 19, left: 0, width: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2, backgroundColor: color.cyan },
  avatar: { position: "relative", flexShrink: 0, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  avatarImage: { backgroundColor: color.surfaceMuted },
  avatarText: { fontWeight: "900", letterSpacing: -0.4 },
  onlineDot: { position: "absolute", right: -1, bottom: 0, borderWidth: 2, backgroundColor: color.green },
  conversationCopy: { flex: 1, minWidth: 0 },
  conversationTopLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  conversationName: { flex: 1, color: color.text, fontSize: 13, fontWeight: "900" },
  conversationTime: { color: color.textMuted, fontSize: 9, fontVariant: ["tabular-nums"] },
  conversationPreview: { color: color.textSecondary, fontSize: 10, lineHeight: 16, marginTop: 4 },
  conversationMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 5 },
  conversationKind: { color: color.textMuted, fontSize: 9 },
  conversationCount: { color: color.cyan, fontSize: 9, fontWeight: "800" },
  listEmptyState: { alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingVertical: 70 },
  emptyChatIcon: { width: 54, height: 54, alignItems: "center", justifyContent: "center", borderRadius: 27, backgroundColor: color.cyanSoft },
  listEmptyTitle: { color: color.text, fontSize: 14, fontWeight: "900", marginTop: 15 },
  listEmptyBody: { maxWidth: 230, color: color.textMuted, fontSize: 10, lineHeight: 17, textAlign: "center", marginTop: 7 },
  emptyAction: { minHeight: 38, alignItems: "center", justifyContent: "center", marginTop: 18, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: color.cyan },
  emptyActionText: { color: color.black, fontSize: 11, fontWeight: "900" },
  detailPane: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: color.canvas },
  detailPaneMobile: { width: "100%", minHeight: 0 },
  detailHeader: { minHeight: 78, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border, backgroundColor: color.canvas },
  detailBackButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", marginLeft: -5 },
  detailHeaderCopy: { flex: 1, minWidth: 0 },
  detailTitle: { color: color.text, fontSize: 16, fontWeight: "900", fontFamily: font.serif },
  detailMeta: { color: color.textMuted, fontSize: 10, marginTop: 4 },
  detailHeaderActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  readonlyBadge: { height: 27, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, borderWidth: 1, borderColor: alpha(color.green, 0.33), borderRadius: radius.small, backgroundColor: color.greenSoft },
  readonlyBadgeText: { color: color.green, fontSize: 9, fontWeight: "800" },
  privacyNotice: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border, backgroundColor: color.cyanSoft },
  privacyNoticeText: { color: color.cyan, fontSize: 10 },
  messageListContent: { flexGrow: 1, paddingHorizontal: 20, paddingVertical: 18 },
  messageList: { flex: 1, minHeight: 0 },
  conversationList: { flex: 1, minHeight: 0 },
  dateDivider: { alignSelf: "center", color: color.textMuted, fontSize: 9, marginBottom: 18 },
  messageLimitNotice: { alignSelf: "center", color: color.amber, fontSize: 9, lineHeight: 14, textAlign: "center", marginHorizontal: 20, marginBottom: 16 },
  messageLine: { flexDirection: "row", alignItems: "flex-end", gap: 8, marginBottom: 14 },
  messageLineOwn: { justifyContent: "flex-end" },
  messageColumn: { maxWidth: "78%", alignItems: "flex-start" },
  messageColumnOwn: { alignItems: "flex-end" },
  senderLabel: { color: color.textMuted, fontSize: 9, marginBottom: 4, marginLeft: 3 },
  bubble: { minHeight: 34, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.medium },
  bubbleIncoming: { borderTopLeftRadius: 4, backgroundColor: color.surfaceRaised },
  bubbleOwn: { borderTopRightRadius: 4, backgroundColor: color.cyanSoft },
  bubbleSticker: { minHeight: 0, paddingHorizontal: 0, paddingVertical: 0, borderRadius: 0, backgroundColor: "transparent" },
  bubbleText: { color: color.text, fontSize: 12, lineHeight: 19 },
  messageTime: { color: color.textMuted, fontSize: 8, marginTop: 4, marginLeft: 3 },
  messageTimeOwn: { marginRight: 3 },
  systemMessage: { alignSelf: "center", maxWidth: "86%", color: color.textMuted, fontSize: 9, lineHeight: 15, textAlign: "center", marginBottom: 16, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.small, backgroundColor: color.surface },
  messageImage: { width: 220, height: 148, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  stickerImage: { width: 132, height: 132, borderRadius: radius.small },
  shareCard: { width: 242, minHeight: 72, flexDirection: "row", overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  shareCover: { width: 74, height: 72, backgroundColor: color.surfaceMuted },
  shareCoverFallback: { width: 74, height: 72, alignItems: "center", justifyContent: "center", backgroundColor: color.surfaceMuted },
  shareCopy: { flex: 1, minWidth: 0, paddingHorizontal: 9, paddingVertical: 8 },
  shareTitle: { color: color.text, fontSize: 10, lineHeight: 15, fontWeight: "800" },
  shareAuthor: { color: color.textSecondary, fontSize: 9, marginTop: 3 },
  shareLabel: { color: color.textMuted, fontSize: 8, marginTop: 4 },
  commentCard: { width: 280, maxWidth: "100%", gap: 10 },
  commentAttribution: { color: color.textSecondary, fontSize: 12, lineHeight: 19 },
  commentText: { color: color.text, fontSize: 13, lineHeight: 23 },
  commentHint: { color: color.textMuted, fontSize: 10, lineHeight: 17 },
  commentImage: { width: "100%", height: 150 },
  commentSource: { flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: color.border, paddingTop: 10 },
  commentSourceCopy: { flex: 1, minWidth: 0, gap: 3 },
  commentSourceLabel: { color: color.textMuted, fontSize: 11, lineHeight: 17 },
  commentSourceTitle: { color: color.text, fontSize: 12, lineHeight: 20 },
  commentCoverFrame: { width: 58, height: 58, borderRadius: radius.small, overflow: "hidden", backgroundColor: color.surfaceMuted },
  commentCover: { width: "100%", height: "100%" },
  commentPlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  callMessage: { minWidth: 156, flexDirection: "row", alignItems: "center", gap: 9 },
  callIcon: { width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: color.cyanSoft },
  callCopy: { minWidth: 0 },
  callTitle: { color: color.text, fontSize: 11, fontWeight: "800" },
  callMeta: { color: color.textMuted, fontSize: 9, marginTop: 3 },
  stickerText: { color: color.text, fontSize: 16, lineHeight: 23, fontWeight: "700" },
  attachmentFallback: { flexDirection: "row", alignItems: "center", gap: 7 },
  attachmentText: { color: color.textSecondary, fontSize: 11 },
  messageEmptyState: { alignItems: "center", justifyContent: "center", paddingVertical: 80 },
  messageEmptyText: { color: color.textMuted, fontSize: 11, marginTop: 10 },
  composerWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border, backgroundColor: color.sidebar },
  composer: { minHeight: 72, flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 18, paddingVertical: 17 },
  composerTool: { width: 34, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.medium },
  composerToolActive: { backgroundColor: color.accentSoft },
  composerInput: { flex: 1, minWidth: 0, minHeight: 38, maxHeight: 132, color: color.text, fontSize: 12, lineHeight: 19, paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  composerDisabled: { opacity: 0.55 },
  composerSend: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.medium, backgroundColor: color.surfaceMuted },
  composerSendReady: { backgroundColor: color.accent },
  composerNotice: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 18, marginTop: 10, paddingHorizontal: 10, paddingVertical: 7, borderLeftWidth: 2, borderLeftColor: color.danger, backgroundColor: color.dangerSoft },
  composerNoticeWarn: { borderLeftColor: color.amber, backgroundColor: color.amberSoft },
  composerNoticeText: { flex: 1, color: color.danger, fontSize: 11, lineHeight: 17 },
  composerNoticeTextWarn: { color: color.amber },
  composerNoticeOk: { borderLeftColor: color.green, backgroundColor: alpha(color.green, 0.1) },
  groupHistoryHead: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 6 },
  groupHistoryLink: { color: color.cyan },
  composerNoticeTextOk: { color: color.green },
  emojiPanel: { maxHeight: 176, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  emojiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 2, paddingHorizontal: 14, paddingVertical: 10 },
  emojiCell: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  emojiImage: { width: 26, height: 26 },
  groupSummaryContent: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  groupSummaryIcon: { width: 68, height: 68, alignItems: "center", justifyContent: "center", borderRadius: 34 },
  groupSummaryTitle: { color: color.text, fontSize: 20, fontWeight: "900", marginTop: 16 },
  groupSummaryBody: { maxWidth: 340, color: color.textSecondary, fontSize: 11, lineHeight: 18, textAlign: "center", marginTop: 8 },
  groupFacts: { width: "100%", maxWidth: 420, flexDirection: "row", gap: 8, marginTop: 24 },
  chatFact: { flex: 1, minHeight: 68, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  chatFactValue: { color: color.text, fontSize: 18, fontWeight: "900", fontVariant: ["tabular-nums"] },
  chatFactLabel: { color: color.textMuted, fontSize: 9, marginTop: 4 },
  groupPrivacyNote: { maxWidth: 420, flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 18, padding: 12, borderLeftWidth: 2, borderLeftColor: color.green, backgroundColor: color.greenSoft },
  groupPrivacyNoteText: { flex: 1, color: color.textSecondary, fontSize: 9, lineHeight: 15 },
  iconButtonActive: { borderColor: alpha(color.amber, 0.5), backgroundColor: color.amberSoft },
  sparkBadge: { position: "absolute", top: -6, right: -6, minWidth: 17, height: 17, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, borderRadius: radius.pill, backgroundColor: color.danger },
  sparkBadgeText: { color: color.white, fontSize: 9, fontWeight: "900", fontVariant: ["tabular-nums"] },
  sparkNotice: { backgroundColor: color.amberSoft },
  sparkNoticeText: { color: color.amber },
  sparkContent: { flexGrow: 1, gap: 20, paddingHorizontal: 20, paddingVertical: 18 },
  sparkFacts: { flexDirection: "row", gap: 8 },
  sparkSection: { gap: 8 },
  sparkSectionHead: { flexDirection: "row", alignItems: "baseline", gap: 7 },
  sparkSectionTitle: { color: color.text, fontSize: 12, fontWeight: "900" },
  sparkSectionCount: { color: color.textMuted, fontSize: 10, fontVariant: ["tabular-nums"] },
  sparkList: { overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  sparkRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  sparkRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  sparkCopy: { flex: 1, minWidth: 0 },
  sparkName: { color: color.text, fontSize: 13, fontWeight: "900" },
  sparkStatus: { color: color.textSecondary, fontSize: 10, lineHeight: 16, marginTop: 3 },
  sparkStrip: { flexDirection: "row", gap: 3, flexShrink: 0 },
  sparkCell: { width: 9, height: 9, backgroundColor: color.surfaceMuted },
  sparkCellBoth: { backgroundColor: color.amber },
  sparkCellHalf: { backgroundColor: alpha(color.amber, 0.32) },
  sparkCount: { width: 92, flexShrink: 0, alignItems: "flex-end" },
  sparkDays: { flexDirection: "row", alignItems: "center", gap: 4 },
  sparkDaysValue: { color: color.text, fontSize: 20, fontWeight: "900", fontFamily: font.serif, fontVariant: ["tabular-nums"] },
  sparkDaysMuted: { color: color.textMuted },
  sparkDaysUnit: { color: color.textMuted, fontSize: 10 },
  sparkLeft: { color: color.textMuted, fontSize: 9, marginTop: 3, fontVariant: ["tabular-nums"] },
  sparkLeftUrgent: { color: color.danger, fontWeight: "800" },
  sparkEmpty: { alignItems: "center", paddingVertical: 56 },
  sparkRenewToggleOn: { borderColor: color.amber, backgroundColor: color.amberSoft },
  renewPanel: { gap: 12, padding: 16, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  renewLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  renewLabel: { color: color.text, fontSize: 12, fontWeight: "900" },
  renewCount: { color: color.amber, fontSize: 11, fontWeight: "800", fontVariant: ["tabular-nums"] },
  renewChips: { flexDirection: "row", gap: 6, marginLeft: "auto" },
  renewTabs: { flexDirection: "row", gap: 6 },
  renewTabOn: { borderColor: color.amber, backgroundColor: color.amberSoft },
  renewTabTextOn: { color: color.amber, fontWeight: "800" },
  renewHint: { color: color.textMuted, fontSize: 10, lineHeight: 16 },
  renewReport: { flex: 1, minWidth: 0 },
  renewNote: { color: color.textMuted, fontSize: 9, lineHeight: 15 },
  renewInput: { flex: 0, width: "100%" },
  renewEmoji: { maxHeight: 132, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium },
  renewPicked: { borderWidth: 1, borderColor: color.amber, backgroundColor: color.amberSoft },
  renewVideos: { gap: 10 },
  renewVideoRow: { gap: 8 },
  renewVideo: { width: 92, gap: 5, padding: 4, borderWidth: 1, borderColor: "transparent", borderRadius: radius.medium },
  renewCover: { width: 82, height: 110, borderRadius: radius.small, backgroundColor: color.surfaceMuted },
  renewCoverEmpty: { alignItems: "center", justifyContent: "center" },
  renewVideoTitle: { color: color.textSecondary, fontSize: 9, lineHeight: 13 },
  renewFooter: { flexDirection: "row", alignItems: "center", gap: 12 },
  renewStart: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.medium, backgroundColor: color.amber },
  renewStartText: { color: color.canvas, fontSize: 11, fontWeight: "900" },
  renewCheck: { width: 18, height: 18, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: color.textMuted, borderRadius: radius.small },
  renewCheckOn: { borderColor: color.amber, backgroundColor: color.amber },
  renewTargets: { maxHeight: 248, borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.medium },
  renewTarget: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 7 },
  renewTargetName: { color: color.text, fontSize: 12, fontWeight: "800" },
  renewTargetNote: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  renewEmpty: { padding: 14, textAlign: "center" },
  renewStatus: { flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1, minWidth: 0 },
  renewStatusText: { flexShrink: 1, color: color.amber, fontSize: 10, fontWeight: "800" },
  renew_waiting: { color: color.textMuted },
  renew_sending: { color: color.cyan, fontWeight: "800" },
  renew_sent: { color: color.green, fontWeight: "800" },
  renew_failed: { color: color.danger, fontWeight: "800" },
  renew_unknown: { color: color.amber, fontWeight: "800" },
  renew_skipped: { color: color.textMuted },
  sparkEmptyIcon: { backgroundColor: color.amberSoft },
  sparkNote: { color: color.textMuted, fontSize: 9, lineHeight: 15 },
  detailEmptyState: { flex: 1, alignItems: "center", justifyContent: "center" },
  detailEmptyTitle: { color: color.text, fontSize: 15, fontWeight: "900", marginTop: 14 },
  detailEmptyBody: { color: color.textMuted, fontSize: 10, marginTop: 6 },
  pressed: { opacity: 0.72 },
});
