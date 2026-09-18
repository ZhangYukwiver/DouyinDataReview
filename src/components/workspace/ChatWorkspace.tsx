import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
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
  ChevronLeft,
  FileText,
  Image as ImageIcon,
  LockKeyhole,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Phone,
  Pause,
  Play,
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
import { type CollectorStatus, LocalCollectorError, isChatReceiving } from "../../services/localCollector";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";
import { fx } from "./motion";
import { splitChatEmoji } from "../../domain/chatEmoji";

const webPointer = Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null;
const webInlineEmoji = Platform.OS === "web" ? ({ verticalAlign: "text-bottom" } as object) : null;
const CHAT_MESSAGE_RENDER_LIMIT = 320;

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

  const rows = [...byId.values()].map((entry) => {
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
    const fallback = row.kind === "group" ? `群聊 ${String(index + 1).padStart(2, "0")}` : `好友会话 ${String(index + 1).padStart(2, "0")}`;
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
  onOpenRecord,
  onOpenSettings,
}: ChatWorkspaceProps) {
  const rows = useMemo(() => buildChatConversationRows(messages, conversations), [conversations, messages]);
  const selfId = useMemo(() => inferSelfId(messages), [messages]);
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const searchRef = useRef<TextInput>(null);

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
  const showDetail = !mobile || mobileDetail;
  const totalMessages = countChatMessages(messages, conversations);

  const selectConversation = (row: ChatConversationRow) => {
    setSelectedId(row.id);
    if (mobile) setMobileDetail(true);
  };

  const receiving = isChatReceiving(status);
  const receptionLabel = !connected ? "未连接采集器"
    : !receiving ? "已暂停接收"
      : status?.chatConnection === "connected" ? "实时接收中"
        : status?.chatConnection === "reconnecting" ? "连接中断，正在重连" : "正在连接消息";
  const controlDisabled = connected && busy && !receiving;

  return (
    <View style={styles.workspace} testID="chat-workspace">
      <View style={styles.receptionBar}>
        <View style={styles.receptionCopy}>
          <View style={[styles.receptionDot, { backgroundColor: receiving && status?.chatConnection === "connected" ? color.green : color.textMuted }]} />
          <Text accessibilityLiveRegion="polite" style={styles.receptionLabel}>{receptionLabel}</Text>
          {receiving && status?.chat.progress ? <Text style={styles.receptionProgress}>整理历史 {status.chat.progress.current}/{status.chat.progress.total || "…"}</Text> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={!connected ? "连接采集器" : receiving ? "暂停接收" : "开始接收"}
          accessibilityState={{ disabled: controlDisabled }}
          disabled={controlDisabled}
          onPress={!connected ? onOpenSettings : onToggleReception}
          style={({ pressed }) => [styles.receptionButton, pressed && styles.pressed, controlDisabled && { opacity: 0.45 }, webPointer]}
        >
          {receiving ? <Pause color={color.textSecondary} size={13} /> : <Play color={color.textSecondary} size={13} />}
          <Text style={styles.receptionButtonText}>{!connected ? "连接采集器" : receiving ? "暂停接收" : "开始接收"}</Text>
        </Pressable>
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
              query={query}
              allRows={rows}
              rows={filteredRows}
              searchRef={searchRef}
              setQuery={setQuery}
              totalMessages={totalMessages}
              privacy={privacy}
              selectedId={selectedId}
            />
          ) : null}
          <ChatDetailPane
            key={selectedForDetail?.id ?? "none"}
            mobile={mobile}
            onBack={() => setMobileDetail(false)}
            onOpenRecord={onOpenRecord}
            privacy={privacy}
            row={selectedForDetail}
            selfId={selfId}
          />
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
    <View style={[styles.listPane, mobile && styles.listPaneMobile]}>
      <View style={styles.listHeader}>
        <View style={styles.listHeaderCopy}>
          <Text style={styles.chatTitle}>消息</Text>
          <Text style={styles.chatSubtitle}>{allRows.length ? `${formatCount(allRows.length)} 个会话 · ${formatCount(totalMessages)} 条消息` : "消息会保存在本机"}</Text>
        </View>
        <Pressable
          accessibilityLabel="聚焦搜索聊天"
          accessibilityRole="button"
          {...fx({ hover: "raise" })}
          onPress={onFocusSearch}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, webPointer]}
        >
          <Search color={color.textSecondary} size={19} strokeWidth={2} />
        </Pressable>
      </View>

      <View style={styles.searchBox}>
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

      <View accessibilityRole="tablist" style={styles.filterRow}>
        {filters.map((item) => (
          <Pressable
            accessibilityLabel={`${item.label}，${item.count} 个会话`}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === item.id }}
            key={item.id}
            {...fx({ hover: "tint" })}
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
      {...fx({ motion: "rise", i: index < 12 ? index + 1 : 0, hover: "tint" })}
      accessibilityLabel={`${visibleName}，${row.messageCount} 条聊天消息`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.conversationItem, selected && styles.conversationItemSelected, pressed && styles.pressed, webPointer]}
      testID={`chat-conversation-${row.id}`}
    >
      <ChatAvatar avatarUrl={row.avatarUrl} initials={row.initials} accent={row.accent} kind={row.kind} online={presence.online} privacy={privacy} size={48} />
      <View style={styles.conversationCopy}>
        <View style={styles.conversationTopLine}>
          <Text numberOfLines={1} style={styles.conversationName}>{visibleName}</Text>
          <Text style={styles.conversationTime}>{formatChatListTime(row.latestAt)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.conversationPreview}>{visiblePreview}</Text>
        <View style={styles.conversationMeta}>
          <Text style={styles.conversationKind}>{row.kind === "group" ? "群聊摘要" : row.kind === "unknown" ? "私聊" : "好友对话"}</Text>
          <Text style={styles.conversationCount}>{formatCount(row.messageCount)} 条</Text>
        </View>
      </View>
      {selected ? <View style={styles.conversationActiveMark} /> : null}
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
      <View style={styles.emptyChatIcon}><MessageCircle color={color.cyan} size={25} strokeWidth={1.8} /></View>
      <Text style={styles.listEmptyTitle}>{busy ? "正在整理聊天" : "还没有聊天快照"}</Text>
      <Text style={styles.listEmptyBody}>{privacy ? "隐私模式已开启；读取后仍只在本机显示。" : "连接采集器后读取聊天，即可在这里回看好友对话。"}</Text>
      <Pressable accessibilityRole="button" onPress={onOpenSettings} style={({ pressed }) => [styles.emptyAction, pressed && styles.pressed, webPointer]}>
        <Text style={styles.emptyActionText}>连接与采集</Text>
      </Pressable>
    </View>
  );
}

function ChatDetailPane({
  mobile,
  onBack,
  onOpenRecord,
  privacy,
  row,
  selfId,
}: {
  mobile: boolean;
  onBack: () => void;
  onOpenRecord: (url: string) => Promise<void>;
  privacy: boolean;
  row: ChatConversationRow | null;
  selfId: string | null;
}) {
  const messageListRef = useRef<FlatList<ChatMessage>>(null);
  const stickToBottomRef = useRef(true);

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

  if (!row) {
    return (
      <View style={[styles.detailPane, mobile && styles.detailPaneMobile]}>
        <View {...fx({ motion: "rise" })} style={styles.detailEmptyState}>
          <View style={styles.emptyChatIcon}><MessageCircle color={color.cyan} size={26} strokeWidth={1.8} /></View>
          <Text style={styles.detailEmptyTitle}>选择一个会话</Text>
          <Text style={styles.detailEmptyBody}>从左侧列表打开好友对话。</Text>
        </View>
      </View>
    );
  }

  const visibleName = privacy ? (row.kind === "group" ? "群聊" : "好友") : row.name;
  const presence = chatPresence(row.lastActiveAt);
  const visibleMessages = row.messages.length > CHAT_MESSAGE_RENDER_LIMIT
    ? row.messages.slice(-CHAT_MESSAGE_RENDER_LIMIT)
    : row.messages;
  const omitted = row.messages.length - visibleMessages.length;
  const handleMessageScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    if (Number.isFinite(distanceFromBottom)) {
      stickToBottomRef.current = distanceFromBottom <= MESSAGE_AUTO_SCROLL_THRESHOLD;
    }
  };

  return (
    <View {...fx({ motion: "fade" })} style={[styles.detailPane, mobile && styles.detailPaneMobile]}>
      <View style={styles.detailHeader}>
        {mobile ? (
          <Pressable accessibilityLabel="返回聊天列表" accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.detailBackButton, pressed && styles.pressed, webPointer]}>
            <ChevronLeft color={color.textSecondary} size={21} strokeWidth={2} />
          </Pressable>
        ) : null}
        <ChatAvatar avatarUrl={row.avatarUrl} initials={row.initials} accent={row.accent} kind={row.kind} online={presence.online} privacy={privacy} size={38} />
        <View style={styles.detailHeaderCopy}>
          <Text numberOfLines={1} style={styles.detailTitle}>{visibleName}</Text>
          <Text style={styles.detailMeta}>
            {presence.text ? `${presence.text} · ` : ""}
            {row.kind === "group" ? "群聊统计摘要" : `${formatCount(row.messageCount)} 条本地消息`}
          </Text>
        </View>
        <View style={styles.detailHeaderActions}>
          <View style={styles.readonlyBadge}>
            <ShieldCheck color={color.green} size={13} strokeWidth={2} />
            <Text style={styles.readonlyBadgeText}>本地保存</Text>
          </View>
          <Pressable accessibilityLabel="聊天详情" accessibilityRole="button" style={[styles.iconButton, webPointer]}>
            <MoreHorizontal color={color.textMuted} size={19} />
          </Pressable>
        </View>
      </View>

      {privacy ? (
        <View style={styles.privacyNotice}>
          <LockKeyhole color={color.cyan} size={15} strokeWidth={2} />
          <Text style={styles.privacyNoticeText}>隐私模式已开启，联系人和消息正文已隐藏。</Text>
        </View>
      ) : null}

      {row.kind === "group" ? (
        <GroupSummary row={row} privacy={privacy} />
      ) : (
        <FlatList
          contentContainerStyle={styles.messageListContent}
          data={visibleMessages}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={<MessageListEmpty privacy={privacy} />}
          ListHeaderComponent={omitted > 0 ? <Text style={styles.messageLimitNotice}>仅显示最近 {CHAT_MESSAGE_RENDER_LIMIT} 条，另有 {omitted} 条更早消息保留在本地快照中。</Text> : <ConversationDateDivider />}
          initialNumToRender={CHAT_MESSAGE_RENDER_LIMIT}
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

      {row.kind !== "group" ? <ReadonlyComposer /> : null}
    </View>
  );
}

function GroupSummary({ row, privacy }: { row: ChatConversationRow; privacy: boolean }) {
  return (
    <ScrollView contentContainerStyle={styles.groupSummaryContent} showsVerticalScrollIndicator={false}>
      <View style={[styles.groupSummaryIcon, { backgroundColor: alpha(row.accent, 0.16) }]}>
        <UsersRound color={row.accent} size={30} strokeWidth={1.7} />
      </View>
      <Text style={styles.groupSummaryTitle}>{privacy ? "群聊" : row.name}</Text>
      <Text style={styles.groupSummaryBody}>群聊正文不会落盘，这里只展示采集到的统计信息。</Text>
      <View style={styles.groupFacts}>
        <ChatFact label="已采集消息" value={formatCount(row.messageCount)} />
        <ChatFact label="本人发言" value={formatCount(row.ownMessageCount)} />
        <ChatFact label="可读正文" value="0" />
      </View>
      <View style={styles.groupPrivacyNote}>
        <ShieldCheck color={color.green} size={16} strokeWidth={2} />
        <Text style={styles.groupPrivacyNoteText}>为保护群聊成员隐私，群聊正文从采集边界开始即被丢弃。</Text>
      </View>
    </ScrollView>
  );
}

function ChatFact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.chatFact}>
      <Text style={styles.chatFactValue}>{value}</Text>
      <Text style={styles.chatFactLabel}>{label}</Text>
    </View>
  );
}

function ConversationDateDivider() {
  return <Text style={styles.dateDivider}>本地聊天快照 · 由采集时间整理</Text>;
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
    return <Text style={styles.systemMessage}>{privacy ? "系统消息已隐藏" : chatPreview(message)}</Text>;
  }
  const own = !privacy && isOwnMessage(message, selfId);
  const sender = privacy ? "好友" : cleanText(message.senderName) ?? (own ? "我" : "对方");
  // Image stickers already carry their own visual surface. Keep the message
  // column/timestamp layout, but remove the generic chat-bubble background and
  // padding so the sticker is shown on its own.
  const framelessSticker = !privacy && message.type === "sticker" && Boolean(message.mediaUrl);
  return (
    <View {...fx({ motion: "rise", i })} style={[styles.messageLine, own && styles.messageLineOwn]}>
      {!own ? <ChatAvatar avatarUrl={row.avatarUrl} accent={row.accent} initials={initialsFor(sender, "friend")} kind="friend" privacy={privacy} size={30} /> : null}
      <View style={[styles.messageColumn, own && styles.messageColumnOwn]}>
        {!own ? <Text style={styles.senderLabel}>{sender}</Text> : null}
        <View style={[styles.bubble, framelessSticker ? styles.bubbleSticker : own ? styles.bubbleOwn : styles.bubbleIncoming]}>
          {privacy ? <Text style={styles.bubbleText}>消息内容已隐藏</Text> : <MessageContent message={message} onOpenRecord={onOpenRecord} />}
        </View>
        <Text style={[styles.messageTime, own && styles.messageTimeOwn]}>{formatMessageTime(message.sentAt)}</Text>
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
      return <Text style={styles.bubbleText}>{renderChatText(text ?? "文字消息")}</Text>;
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
    return <Text style={styles.stickerText}>{renderChatText(message.text && !/^\[表情包\]$/u.test(message.text) ? message.text : "表情包")}</Text>;
  }
  if (message.type === "image") {
    return <View style={styles.attachmentFallback}><ImageIcon color={color.cyan} size={17} /><Text style={styles.attachmentText}>图片消息</Text></View>;
  }
  if (message.type === "unknown" && !message.text) {
    return <View style={styles.attachmentFallback}><FileText color={color.textMuted} size={16} /><Text style={styles.attachmentText}>暂未解析的消息</Text></View>;
  }
  return <Text style={styles.bubbleText}>{renderChatText(message.text ?? chatPreview(message))}</Text>;
}

function ReadonlyComposer() {
  return (
    <View style={styles.composer}>
      <View style={styles.composerTools}>
        <Smile color={color.textMuted} size={19} strokeWidth={1.8} />
        <ImageIcon color={color.textMuted} size={19} strokeWidth={1.8} />
        <Mic color={color.textMuted} size={19} strokeWidth={1.8} />
      </View>
      <TextInput editable={false} placeholder="仅接收消息" placeholderTextColor={color.textMuted} style={styles.composerInput} />
      <View style={styles.composerSend}><Send color={color.textMuted} size={17} strokeWidth={1.8} /></View>
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
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(accent, 0.19) }]}>
      {showImage ? (
        <Image
          accessibilityLabel="联系人头像"
          onError={() => setImageFailed(true)}
          resizeMode="cover"
          source={{ uri: safeChatAvatarUrl(avatarUrl)! }}
          style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
        />
      ) : kind === "group" ? <UsersRound color={accent} size={Math.round(size * 0.45)} strokeWidth={1.8} /> : <Text style={[styles.avatarText, { color: accent, fontSize: Math.max(11, Math.round(size * 0.32)) }]}>{initials}</Text>}
      {online ? <View {...fx({ motion: "pulse" })} style={[styles.onlineDot, { width: Math.max(7, Math.round(size * 0.2)), height: Math.max(7, Math.round(size * 0.2)), borderRadius: size, borderColor: color.sidebar }]} /> : null}
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

// 抖音内置小表情以文字代码传输（如 [宕机]），按字典换成行内小图，没收录的原样显示。
function renderChatText(text: string): React.ReactNode {
  const parts = splitChatEmoji(text);
  if (!parts.some((part) => "emoji" in part)) return text;
  return parts.map((part, index) => "emoji" in part
    ? <Image accessibilityLabel={part.emoji} key={index} source={{ uri: part.url }} style={[styles.inlineEmoji, webInlineEmoji]} />
    : part.text);
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
  receptionCopy: { flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 7 },
  receptionDot: { width: 6, height: 6, borderRadius: 3 },
  receptionLabel: { color: color.textSecondary, fontSize: 11 },
  receptionProgress: { color: color.textMuted, fontSize: 10 },
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
  inlineEmoji: { width: 16, height: 16, marginHorizontal: 1 },
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
  composer: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border, backgroundColor: color.sidebar },
  composerTools: { flexDirection: "row", alignItems: "center", gap: 12 },
  composerInput: { flex: 1, minWidth: 0, height: 38, color: color.textMuted, fontSize: 11, paddingHorizontal: 11, borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  composerSend: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.medium, backgroundColor: color.surfaceMuted },
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
  detailEmptyState: { flex: 1, alignItems: "center", justifyContent: "center" },
  detailEmptyTitle: { color: color.text, fontSize: 15, fontWeight: "900", marginTop: 14 },
  detailEmptyBody: { color: color.textMuted, fontSize: 10, marginTop: 6 },
  pressed: { opacity: 0.72 },
});
