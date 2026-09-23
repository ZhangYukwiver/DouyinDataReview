import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const Component = () => null;
  return {
    FlatList: Component,
    Image: Component,
    Platform: { OS: "web" },
    Pressable: Component,
    ScrollView: Component,
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: Component,
    TextInput: Component,
    View: Component,
  };
});

vi.mock("lucide-react-native", () => {
  const Component = () => null;
  return Object.fromEntries([
    "ChevronLeft", "FileText", "Image", "LockKeyhole", "MessageCircle", "Mic", "MoreHorizontal", "Phone", "Pause", "Play", "RefreshCw", "Search", "Send", "ShieldCheck", "Smile", "UsersRound", "Video", "X",
  ].map((name) => [name, Component]));
});

import type { ChatMessage } from "../../domain/chatRecords";
import { buildChatConversationRows, chatPresence, MessageContent } from "./ChatWorkspace";

function message(id: string, conversationId: string, sentAt: string, text: string | null, type: ChatMessage["type"] = "text"): ChatMessage {
  return {
    id,
    conversationId,
    conversationType: "friend",
    conversationName: null,
    senderId: "friend",
    senderName: "小伙伴",
    sentAt,
    type,
    text,
    mediaUrl: null,
    share: type === "share" ? { title: text, author: null, coverUrl: null, url: null } : null,
    callDurationSeconds: null,
  };
}

describe("buildChatConversationRows", () => {
  it("merges friend messages, keeps a useful preview, and sorts by latest time", () => {
    const rows = buildChatConversationRows([
      message("a-1", "a", "2026-08-01T10:00:00Z", "早安"),
      message("a-2", "a", "2026-08-01T11:00:00Z", null, "unknown"),
      message("b-1", "b", "2026-08-02T10:00:00Z", "晚安"),
    ], [
      { id: "a", kind: "friend", name: null, messageCount: 2, ownMessageCount: 1 },
      { id: "b", kind: "friend", name: "小明", avatarUrl: "https://p3.douyinpic.com/x.jpg", messageCount: 1, ownMessageCount: 0 },
    ]);

    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ name: "小明", avatarUrl: "https://p3.douyinpic.com/x.jpg", messageCount: 1, preview: "晚安" });
    expect(rows[1]).toMatchObject({ name: "好友会话 02", messageCount: 2, preview: "早安" });
  });

  it("does not expose group bodies and still renders a summary row", () => {
    const rows = buildChatConversationRows([
      { ...message("group-body", "g", "2026-08-01T10:00:00Z", "群正文"), conversationType: "group" },
    ], [{ id: "g", kind: "group", name: "测试群", messageCount: 12, ownMessageCount: 3 }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "group", name: "测试群", messageCount: 12, messages: [], preview: "群聊 · 已采集 12 条消息" });
  });

  it("uses a sender avatar when the conversation catalog has no avatar", () => {
    const rows = buildChatConversationRows([{
      ...message("avatar-message", "avatar-conversation", "2026-08-03T10:00:00Z", "你好"),
      senderAvatarUrl: "https://p3.douyinpic.com/contact.jpg",
    }], [{ id: "avatar-conversation", kind: "friend", name: "联系人", messageCount: 1, ownMessageCount: 0 }]);

    expect(rows[0]?.avatarUrl).toBe("https://p3.douyinpic.com/contact.jpg");
  });
});

describe("MessageContent", () => {
  it("renders a title-only legacy share as a normal text message", () => {
    const element = MessageContent({
      message: {
        ...message("plain-share-1", "conversation-1", "2026-08-03T10:00:00Z", "把手伸模型佬的钱包里就算了", "share"),
        share: { title: "把手伸模型佬的钱包里就算了", author: null, coverUrl: null, url: null },
      },
      onOpenRecord: vi.fn(),
    });

    expect(element).toMatchObject({ props: { children: "把手伸模型佬的钱包里就算了" } });
  });

  it("keeps a share card when share metadata contains a real link", () => {
    const element = MessageContent({
      message: {
        ...message("real-share-1", "conversation-1", "2026-08-03T10:00:00Z", "真正的分享", "share"),
        share: {
          title: "真正的分享",
          author: "作者",
          coverUrl: "https://p3.douyinpic.com/cover.jpg",
          url: "https://www.douyin.com/video/123",
        },
      },
      onOpenRecord: vi.fn(),
    });

    expect(element).toMatchObject({
      props: {
        accessibilityLabel: "打开分享的视频",
        accessibilityRole: "link",
      },
    });
  });

  it("renders a sticker media URL instead of replacing it with the label", () => {
    const sticker = {
      ...message("sticker-1", "conversation-1", "2026-08-03T10:00:00Z", "[表情包]", "sticker"),
      mediaUrl: "https://p3.douyinpic.com/sticker.png",
    };

    const element = MessageContent({ message: sticker, onOpenRecord: vi.fn() });

    expect(element).toMatchObject({
      props: {
        accessibilityLabel: "聊天表情包",
        resizeMode: "contain",
        source: { uri: sticker.mediaUrl },
      },
    });
  });

  it("keeps the text fallback when a sticker has no media URL", () => {
    const element = MessageContent({
      message: message("sticker-2", "conversation-1", "2026-08-03T10:00:00Z", "比心", "sticker"),
      onOpenRecord: vi.fn(),
    });

    expect(element).toMatchObject({ props: { children: "比心" } });
  });

  it("renders Douyin emoji codes as inline images and keeps unknown codes as text", () => {
    const element = MessageContent({
      message: message("text-emoji", "conversation-1", "2026-08-03T10:00:00Z", "[宕机]哈哈[自创代码]"),
      onOpenRecord: vi.fn(),
    }) as { props: { children: Array<string | { props: { accessibilityLabel: string; source: { uri: string } } }> } };

    const [emoji, ...rest] = element.props.children;
    expect(emoji).toMatchObject({ props: { accessibilityLabel: "[宕机]", source: { uri: expect.stringMatching(/^https:\/\//u) } } });
    expect(rest).toEqual(["哈哈", "[自创代码]"]);
  });
});

describe("chatPresence", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const MINUTE = 60_000;
  const HOUR = 3_600_000;

  it("mirrors the wording douyin itself uses for each distance", () => {
    // 抖音把 10 分钟内的心跳都算“在线”。
    expect(chatPresence(at(0))).toEqual({ online: true, text: "在线" });
    expect(chatPresence(at(9 * MINUTE))).toEqual({ online: true, text: "在线" });
    expect(chatPresence(at(25 * MINUTE))).toEqual({ online: false, text: "15分钟内在线" });
    expect(chatPresence(at(3 * HOUR))).toEqual({ online: false, text: "2小时内在线" });
  });

  it("says nothing when there is no timestamp or it is older than yesterday", () => {
    expect(chatPresence(null)).toEqual({ online: false, text: "" });
    expect(chatPresence("not a date")).toEqual({ online: false, text: "" });
    expect(chatPresence(at(3 * 24 * HOUR))).toEqual({ online: false, text: "" });
  });
});
