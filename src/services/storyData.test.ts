import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const Component = () => null;
  return {
    Platform: { OS: "web" },
    Pressable: Component,
    ScrollView: Component,
    StyleSheet: { create: <T,>(value: T) => value, absoluteFill: {} },
    Text: Component,
    useWindowDimensions: () => ({ width: 1440, height: 900 }),
    View: Component,
  };
});
vi.mock("lucide-react-native", () => {
  const Component = () => null;
  return Object.fromEntries([
    "Bookmark", "BookOpen", "CalendarDays", "ChevronLeft", "ChevronRight", "CircleCheck", "Clock6", "Clock9",
    "Clock12", "Compass", "Download", "Eye", "Feather", "Heart", "Hourglass", "Image", "Info", "Layers", "Lock",
    "MessageCircle", "Moon", "Mountain", "Pause", "Phone", "Play", "Radio", "RotateCcw", "Send", "Settings2",
    "Signature", "SkipForward", "Star", "Sticker", "Target", "Telescope", "UserRound",
  ].map((name) => [name, Component]));
});
vi.mock("react-native-svg", () => {
  const Component = () => null;
  return {
    default: Component,
    ...Object.fromEntries(["Circle", "Defs", "Ellipse", "Line", "LinearGradient", "Path", "RadialGradient", "Rect", "Stop", "Text", "TextPath"].map((name) => [name, Component])),
  };
});

import type { ChatConversationSummary, ChatMessage } from "../domain/chatRecords";
import type { PersonalRecordCollection, PersonalVideoRecord } from "../domain/personalRecords";
import { buildReportModel } from "../components/workspace/ReportWorkspace";
import { buildStoryData, clearStoryData, signatureName, SIGNATURE_WORDS, STORY_STORAGE_KEY, writeStoryData } from "./storyData";

function rec(id: string, extra: Partial<PersonalVideoRecord>): PersonalVideoRecord {
  return { id, title: `内容 ${id}`, author: "创作者甲", occurredAt: null, url: `https://www.douyin.com/video/${id}`, ...extra };
}
const music1 = { id: "m1", title: "旋律一", author: "音乐人" };

const records: PersonalRecordCollection = {
  watch_history: [
    rec("w1", { videoId: "v1", title: "#城市散步 清晨路线", occurredAt: "2026-01-05T09:00:00+08:00", publishedAt: "2026-01-01T00:00:00+08:00", authorAvatarUrl: "https://a/1.png", topics: ["城市散步"], mediaType: "video", durationSeconds: 30, music: music1, watchProgress: { percent: 95 }, coverUrl: "https://c/w1.jpg", stats: { diggCount: 1200 } }),
    rec("w2", { videoId: "v2", occurredAt: "2026-02-10T09:30:00+08:00", topics: ["城市散步", "手作"], mediaType: "video", durationSeconds: 120, music: music1, watchProgress: { percent: 50 } }),
    rec("w3", { videoId: "v3", author: "创作者乙", occurredAt: "2026-02-11T21:00:00+08:00", publishedAt: "2025-11-01T00:00:00+08:00", topics: ["家常菜"], mediaType: "image", durationSeconds: 700, music: { id: "m2", title: "旋律二", author: null }, watchProgress: { percent: 10 }, stats: { diggCount: 5 } }),
    rec("w4", { videoId: "v1", occurredAt: "2026-03-01T09:15:00+08:00", topics: ["城市散步"], mediaType: "video", durationSeconds: 30, music: music1, watchProgress: { percent: 100 } }),
    rec("w5", { videoId: "v4", author: "创作者丙", occurredAt: "2026-03-01T22:00:00+08:00", occurredAtSource: "archive_action", mediaType: "live", coverUrl: "https://c/w5.jpg" }),
    rec("w6", { url: null, author: null }),
  ],
  liked_videos: [
    rec("l1", { videoId: "v1", occurredAt: "2026-03-02T10:00:00+08:00", coverUrl: "https://c/l1.jpg", title: "喜欢一", topics: ["城市散步", "AI"], stats: { diggCount: 999999 } }),
    rec("l2", { videoId: "v2", author: "创作者乙", occurredAt: "2026-01-20T10:00:00+08:00", topics: ["ai", "手作", "ai"] }),
  ],
  favorite_videos: [
    rec("f1", { videoId: "v1", occurredAt: "2026-03-05T11:00:00+08:00", coverUrl: "https://c/f1.jpg", title: "收藏一", topics: ["手作"] }),
    rec("f2", { videoId: "v3", author: "创作者乙", occurredAt: "2026-02-20T11:00:00+08:00" }),
  ],
};

function msg(id: string, type: ChatMessage["type"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, conversationId: "c1", conversationType: "friend", conversationName: "小明", senderId: "u2", senderName: "小明", sentAt: "2026-02-01T20:00:00+08:00", type, text: type === "text" ? "你好" : null, mediaUrl: null, share: null, callDurationSeconds: null, ...extra };
}
const conversations: ChatConversationSummary[] = [
  { id: "c1", kind: "friend", name: "小明", avatarUrl: "https://a/m.png", messageCount: 7, ownMessageCount: 3 },
  { id: "g1", kind: "group", name: "读书群", messageCount: 40, ownMessageCount: 5 },
];
const messages: ChatMessage[] = [
  msg("m1", "text"), msg("m2", "text"), msg("m3", "text"), msg("m4", "text"),
  msg("m5", "image", { mediaUrl: "https://i/1.jpg" }),
  msg("m6", "share", { share: { title: "分享视频", author: "某人", coverUrl: "https://c/s.jpg", url: "https://v/1" } }),
  msg("m7", "call", { callDurationSeconds: 120 }),
  msg("m8", "text", { conversationId: "g1", conversationType: "group", conversationName: "读书群" }),
  // the same platform sentence in three conversations: boilerplate, not something the person said
  msg("t1", "text", { conversationId: "cA", text: "我们已互相关注，可以开始聊天了 1" }),
  msg("t2", "text", { conversationId: "cB", text: "我们已互相关注，可以开始聊天了 2" }),
  msg("t3", "text", { conversationId: "cC", text: "我们已互相关注，可以开始聊天了 3" }),
  msg("t4", "text", { text: "看看 https://v.douyin.com/abc [捂脸] 城市散步 真好看 #手作" }),
  msg("s1", "share", { share: { title: "游戏实况 #怪物猎人 #steam游戏", author: "玩家甲", coverUrl: null, url: null } }),
  msg("s2", "share", { share: { title: "#怪物猎人 精彩片段", author: null, coverUrl: null, url: "https://v/2" } }),
  msg("s3", "share", { share: { title: "#怪物猎人 没有证据", author: null, coverUrl: null, url: null } }),
];

describe("story data", () => {
  const model = buildReportModel(records, messages, null, conversations);
  const data = buildStoryData(model, { records, chatMessages: messages, chatConversations: conversations, source: "collector", updatedAt: "2026-09-03T10:00:00+08:00", warnings: ["a", "b"] });

  it("summarises the sample, time and kept chapters from the records", () => {
    expect(data.counts).toEqual({ watch: 6, liked: 2, favorite: 2, chat: 54, events: 10 });
    expect(data.unique).toBe(5);
    expect(data.activeDays).toBe(8);
    expect(data.range).toEqual(["2026-01-05", "2026-03-05"]);
    expect(data.year).toBe(2026);
    expect(buildStoryData({ ...model, year: 2030 }, { records: { watch_history: [], liked_videos: [], favorite_videos: [] }, chatMessages: [], chatConversations: [], source: "archive", updatedAt: null, warnings: [] }).year).toBe(2030);
    expect(data.peakDay).toBe("2026-03-01");
    expect(data.days).toHaveLength(8); // one entry per active day, in date order
    expect(data.days[0]).toEqual(["2026-01-05", 1]);
    expect(data.days.find(([day]) => day === "2026-03-01")).toEqual(["2026-03-01", 2]);
    expect(data.peakHour).toBe(new Date("2026-01-05T09:00:00+08:00").getHours());
    expect(data.months[0]).toBe(2);
    expect(data.months[2]).toBe(4);
    expect(data.timeSources).toEqual({ platform_action: 8, archive_action: 1, unknown: 1 });
    expect(data.intersection).toEqual({ watchLiked: 2, watchFavorite: 2, likedFavorite: 1, allThree: 1 });
    expect(data.progress).toEqual({ done: 0.5, mid: 0.25, shallow: 0.25 });
    expect(data.recent.map((card) => [card.kind, card.coverUrl])).toEqual([["favorite", "https://c/f1.jpg"], ["favorite", null], ["liked", null], ["watch", "https://c/w5.jpg"]]);
    expect(data.caveats).toEqual({ noTime: 1, noVideoId: 1, warnings: 2 });
  });

  it("signs the volume with one word from each of the three lists", () => {
    const [when, what, how] = data.profile.title.split(" · ");
    expect(when).toMatch(/^(凌晨|清晨|上午|正午|午后|傍晚|夜里)$/u); // the peak hour is read in local time
    expect([what, how]).toEqual(["长镜", "留到结尾"]); // 25% run past ten minutes, half were finished
    expect(data.profile.english.split(" · ")).toHaveLength(3);
    const empty = buildStoryData(buildReportModel({ watch_history: [], liked_videos: [], favorite_videos: [] }, [], null, []), { records: { watch_history: [], liked_videos: [], favorite_videos: [] }, chatMessages: [], chatConversations: [], source: "archive", updatedAt: null, warnings: [] });
    expect(empty.profile.title).toBe("不定 · 寻常 · 不作停留");
    expect(empty.profile.name).toBe("不定时的空手客");
  });

  it("names every combination of the three lists", () => {
    expect(data.profile.name).toMatch(/的片尾常客$/u); // 长镜 × 留到结尾, prefixed by the peak hour
    expect(data.profile.nameEnglish).toBe("ROLLING CREDITS");
    expect(data.profile.reading).toContain("长片子你多半整段看下来");
    const named = new Set<string>();
    for (const when of SIGNATURE_WORDS.when) for (const what of SIGNATURE_WORDS.what) for (const how of SIGNATURE_WORDS.how) {
      const entry = signatureName(when, what, how);
      expect(entry.name).not.toBe("无名的一卷"); // every 6 × 5 pair carries a name, every hour a prefix
      expect(entry.reading.length).toBeGreaterThan(40);
      named.add(entry.name);
    }
    expect(named.size).toBe(SIGNATURE_WORDS.when.length * SIGNATURE_WORDS.what.length * SIGNATURE_WORDS.how.length);
  });

  it("summarises the mix and echo chapters", () => {
    expect(data.topTopic).toMatchObject({ name: "城市散步", count: 4 });
    expect(data.topCreator).toEqual({ name: "创作者甲", unique: 2, avatarUrl: "https://a/1.png" });
    expect(data.media).toEqual([{ label: "视频", share: 0.6 }, { label: "图文", share: 0.2 }, { label: "直播", share: 0.2 }]);
    expect(data.durations).toEqual([{ label: "< 1 分钟", share: 0.5 }, { label: "1–10 分钟", share: 0.25 }, { label: "10 分钟以上", share: 0.25 }]);
    expect(data.music).toEqual({ title: "旋律一", author: "音乐人", count: 3 });
    expect(data.musics).toEqual([{ title: "旋律一", author: "音乐人", count: 3 }]);
    expect(data.musicsCount).toBe(2);
    expect(data.topicsCount).toBe(5);
    // each headline tag gets the card that carries it: w1 shows 城市散步 in its title (beats the newer cover-only l1); that spends content v1,
    // so for 手作 the bare l2 beats f1's cover (same v1) rather than repeating it; ai / AI are one term and fall back to v1 as the only carrier
    expect(data.topics.map((topic) => [topic.name, topic.card && topic.card.title, topic.card && topic.card.kind])).toEqual([["城市散步", "#城市散步 清晨路线", "watch"], ["手作", "内容 l2", "liked"], ["ai", "喜欢一", "liked"], ["家常菜", "内容 w3", "watch"], ["AI", "喜欢一", "liked"]]);
    expect(data.creators.map((item) => [item.name, item.count])).toEqual([["创作者甲", 5], ["创作者乙", 3], ["创作者丙", 1]]);
    expect(data.creatorsCount).toBe(3);
    // like counts: one entry per content (l1 repeats v1, so w1's count wins), lower-middle median
    expect(data.heat).toEqual({ sampled: 2, median: 5, hottest: { title: "#城市散步 清晨路线", count: 1200, url: "https://www.douyin.com/video/w1" }, quietest: { title: "内容 w3", count: 5, url: "https://www.douyin.com/video/w3" } });
    expect(data.age).toEqual({ sampled: 2, medianDays: 4, bands: [{ label: "一周内", share: 0.5 }, { label: "三个月内", share: 0 }, { label: "更早", share: 0.5 }] });
    expect(data.length).toEqual({ seconds: model.attentionSeconds, medianDuration: 30, longest: { title: "内容 w3", seconds: 700 } });
    expect(model.attentionSeconds).toBeCloseTo(188.5, 1);
    expect(data.chat).toMatchObject({ friendMessages: 14, callSeconds: 120, conversations: 2, share: { title: "分享视频", coverUrl: "https://c/s.jpg" } });
    expect(data.chat?.forms.map((form) => form.count)).toEqual([8, 1, 4, 0, 1]);
    expect(data.chat?.top[0]).toMatchObject({ name: "读书群", kind: "group", messageCount: 40 });
    expect(data.profile.title).toBeTruthy();
  });

  it("ranks the terms behind each stream", () => {
    // "AI" and "ai" are one term, shown with the spelling met first; a term counts once per record
    expect(data.lexicon.liked.top).toEqual([
      { name: "AI", count: 2, share: 1 },
      { name: "城市散步", count: 1, share: .5 },
      { name: "手作", count: 1, share: .5 },
    ]);
    expect(data.lexicon.liked).toMatchObject({ total: 2, sampled: 2, distinct: 3, coverage: 1, halfAt: 1, excluded: 0 });
    expect(data.lexicon.watch).toMatchObject({ total: 6, sampled: 4, distinct: 3, halfAt: 1 });
    expect(data.lexicon.favorite).toMatchObject({ total: 2, sampled: 1, distinct: 1, coverage: 1, halfAt: 1, top: [{ name: "手作", count: 1, share: 1 }] });
  });

  it("reads chat words without the platform boilerplate or the group thread", () => {
    const chat = data.lexicon.chat!;
    // three copies of the same platform sentence (digits aside) across three conversations
    expect(chat.excluded).toBe(3);
    expect(chat).toMatchObject({ total: 8, sampled: 5, distinct: 4, halfAt: 1 });
    // the group message repeats "你好"; counting it would push this to 5
    expect(chat.top[0]).toEqual({ name: "你好", count: 4, share: .8 });
    expect(chat.top.map((term) => term.name)).toEqual(["你好", "城市", "散步", "真好"]);
  });

  it("reads the topic tags off the video cards friends shared", () => {
    const shared = data.lexicon.shared!;
    // three cards carry share evidence; the fourth has only a title, so it never becomes a card
    expect(shared).toMatchObject({ total: 3, sampled: 2, distinct: 2, halfAt: 1 });
    expect(shared.top).toEqual([{ name: "怪物猎人", count: 2, share: 1 }, { name: "steam游戏", count: 1, share: .5 }]);
    // both sides are too small here to be worth comparing
    expect(data.lexicon.contrast).toBeNull();
  });

  it("contrasts what gets shared with what gets liked", () => {
    const liked = Array.from({ length: 12 }, (_, i) => rec(`x${i}`, { videoId: `x${i}`, topics: i < 10 ? ["共同话题", "拼装模型"] : ["只在点赞里"] }));
    const shares = Array.from({ length: 12 }, (_, i) => msg(`sx${i}`, "share", { share: { title: i < 10 ? "#共同话题 #怪物猎人" : "#只在分享里", author: "玩家", coverUrl: null, url: null } }));
    const only = { watch_history: [], liked_videos: liked, favorite_videos: [] };
    const wide = buildStoryData(buildReportModel(only, shares, null, []), { records: only, chatMessages: shares, chatConversations: [], source: "collector", updatedAt: null, warnings: [] });
    expect(wide.lexicon.contrast).toEqual({ both: ["共同话题"], sharedOnly: ["怪物猎人", "只在分享里"], likedOnly: ["拼装模型", "只在点赞里"] });
  });

  it("counts how many records actually carry each field", () => {
    expect(data.fields.map((field) => [field.label, field.count, field.base])).toEqual([
      ["行为时间", 9, 10],
      ["作品 ID", 9, 10],
      ["话题标签", 7, 10],
      ["时长", 4, 10],
      ["发布时间", 2, 10],
      ["点赞数", 3, 10],
      ["已看进度", 4, 6],
    ]);
    expect(data.fields[0]!.share).toBeCloseTo(data.reliableRatio, 10);
  });

  it("drops the chat words where the browser cannot segment", () => {
    vi.stubGlobal("Intl", { Collator: Intl.Collator, DateTimeFormat: Intl.DateTimeFormat, NumberFormat: Intl.NumberFormat });
    try {
      const plain = buildStoryData(model, { records, chatMessages: messages, chatConversations: conversations, source: "collector", updatedAt: null, warnings: [] });
      expect(plain.lexicon.chat).toBeNull();
      expect(plain.lexicon.shared).not.toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it("leaves chat out of archive imports and round-trips through storage", () => {
    const archive = buildStoryData(model, { records, chatMessages: [], chatConversations: [], source: "archive", updatedAt: null, warnings: [], archive: { parsedFileCount: 3, ignoredFileCount: 1 } });
    expect(archive.chat).toBeNull();
    expect(archive.counts.chat).toBeNull();
    expect(archive.lexicon.chat).toBeNull();
    expect(archive.lexicon.shared).toBeNull();
    expect(archive.lexicon.contrast).toBeNull();
    expect(archive.lexicon.liked.top[0]).toEqual({ name: "AI", count: 2, share: 1 });
    expect(archive.source).toMatchObject({ kind: "archive", parsedFileCount: 3, ignoredFileCount: 1 });
    const store = new Map<string, string>();
    const storage = { setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } as unknown as Storage;
    writeStoryData(archive, storage);
    expect(JSON.parse(store.get(STORY_STORAGE_KEY)!).unique).toBe(5);
    clearStoryData(storage);
    expect(store.size).toBe(0);
  });
});
