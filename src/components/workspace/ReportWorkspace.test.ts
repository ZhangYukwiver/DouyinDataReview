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

import type { ChatMessage } from "../../domain/chatRecords";
import type { PersonalRecordCollection, PersonalVideoRecord } from "../../domain/personalRecords";
import { buildReportModel, selectBookCoverUris, spawnVortex, stepVortex, vortexFrame } from "./ReportWorkspace";
import { segmentEdgeClip } from "./BookGate";

function video(id: string, occurredAt: string, percent?: number): PersonalVideoRecord {
  return {
    id,
    videoId: "video-1",
    title: "示例内容",
    author: "示例作者",
    occurredAt,
    occurredAtSource: "platform_action",
    url: null,
    mediaType: "video",
    topics: ["知识"],
    durationSeconds: 42,
    watchProgress: percent === undefined ? null : { percent },
  };
}

// These display-time fixtures use local wall time so the assertions hold in every runner timezone.
describe("buildReportModel", () => {
  it("keeps counts, replay, intersections and attention grounded in records", () => {
    const records: PersonalRecordCollection = {
      watch_history: [video("watch-1", "2026-08-20T12:00:00", 80), video("watch-2", "2026-08-21T12:00:00", 40)],
      liked_videos: [video("liked-1", "2026-08-21T12:05:00")],
      favorite_videos: [video("favorite-1", "2026-08-21T12:10:00")],
    };
    const chats: ChatMessage[] = [{
      id: "chat-1",
      conversationId: "conversation-1",
      conversationName: null,
      senderId: null,
      senderName: null,
      sentAt: "2026-08-21T12:20:00",
      type: "text",
      text: null,
      mediaUrl: null,
      share: null,
      callDurationSeconds: null,
    }];

    const model = buildReportModel(records, chats, null);

    expect(model.total).toBe(4);
    expect(model.unique).toBe(1);
    expect(model.replays).toBe(1);
    expect(model.intersection.allThree).toBe(1);
    expect(model.completion).toBe(60);
    expect(model.peakHour).toBe(12);
    expect(model.overlap).toBe(100);
    // 新增的档案页数据
    expect(model.attentionSeconds).toBeCloseTo(0.8 * 42 + 0.4 * 42);
    expect(model.evidence.watch.count).toBe(2);
    expect(model.evidence.watch.dots).toBe(1);
    expect(model.evidence.watch.range).toEqual(["2026-08-20", "2026-08-21"]);
    // 8 月 20/21 日 → 8 月后半月桶（7*2+1）
    expect(model.evidence.watch.months[15]).toBeGreaterThan(0);
    expect(model.evidence.watch.months[14]).toBe(0);
    expect(model.evidence.chat.caveat).toEqual(["observed", "partial"]);
    expect(model.evidence.creators.count).toBe(1);
    expect(model.events).toHaveLength(5);
    expect(model.events[0]).toMatchObject({ kind: "chat", label: "聊天互动", time: "12:20" });
    expect(model.calendar).toHaveLength(12);
    expect(model.calendar[7]!.some((level) => level > 0)).toBe(true);
    expect(model.calendar[0]!.every((level) => level === 0)).toBe(true);
    expect(model.seasons).toHaveLength(3);
    expect(model.seasons[1]!.title.startsWith("夏季")).toBe(true);
    expect(model.seasons[0]!.title).toBe("春季暂无观测");
  });

  it("keeps report-wide axes all-period while the profile axes use the recent window", () => {
    const records: PersonalRecordCollection = {
      watch_history: [
        video("old", "2026-08-01T12:00:00+08:00", 20),
        video("new", "2026-08-10T12:00:00+08:00", 90),
      ],
      liked_videos: [video("old-like", "2026-08-01T12:05:00+08:00")],
      favorite_videos: [],
    };

    const model = buildReportModel(records, [], null);

    expect(model.completion).toBe(55);
    expect(model.axes[1]?.value).toBe(55);
    expect(model.profileMetrics.completion).toBe(90);
    expect(model.profileAxes[1]?.value).toBe(90);
    expect(model.profileMetrics.windowed).toBe(true);
    expect(model.profileMetrics.windowWatchRecords).toBe(1);
  });

  it("compresses uninterrupted viewing into boundaries while keeping keeps and chat breaks", () => {
    const watch = (id: string, occurredAt: string): PersonalVideoRecord => ({
      ...video(id, occurredAt),
      id,
      videoId: id,
    });
    const chat = (id: string, sentAt: string): ChatMessage => ({
      id,
      conversationId: id,
      conversationType: "friend",
      conversationName: null,
      senderId: null,
      senderName: null,
      sentAt,
      type: "text",
      text: null,
      mediaUrl: null,
      share: null,
      callDurationSeconds: null,
    });
    const records: PersonalRecordCollection = {
      watch_history: [
        watch("watch-a", "2026-08-21T12:00:00"),
        watch("watch-b", "2026-08-21T12:02:00"),
        watch("watch-c", "2026-08-21T12:05:00"),
        watch("watch-d", "2026-08-21T12:06:00"),
        watch("watch-e", "2026-08-21T12:08:00"),
      ],
      liked_videos: [watch("like-a", "2026-08-21T12:01:00")],
      favorite_videos: [watch("favorite-a", "2026-08-21T12:03:00")],
    };
    const model = buildReportModel(records, [chat("chat-a", "2026-08-21T12:04:00")], null);

    expect(model.events.map((event) => ({ kind: event.kind, time: event.time }))).toEqual([
      { kind: "watch", time: "12:08" },
      { kind: "watch", time: "12:05" },
      { kind: "chat", time: "12:04" },
      { kind: "kept", time: "12:03" },
      { kind: "watch", time: "12:02" },
      { kind: "kept", time: "12:01" },
      { kind: "watch", time: "12:00" },
    ]);
  });

  it("selects the newest unique book covers and honors privacy mode", () => {
    const cover = (id: string, occurredAt: string, videoId = id): PersonalVideoRecord => ({
      ...video(id, occurredAt),
      videoId,
      coverUrl: `https://p3.douyinpic.com/${id}.jpg`,
    });
    const records: PersonalRecordCollection = {
      watch_history: [
        cover("old", "2026-08-01T12:00:00Z"),
        cover("new-1", "2026-08-06T12:00:00Z"),
        cover("new-2", "2026-08-05T12:00:00Z"),
        cover("duplicate", "2026-08-04T12:00:00Z", "shared"),
      ],
      liked_videos: [cover("same-video", "2026-08-03T12:00:00Z", "shared"), cover("new-3", "2026-08-02T12:00:00Z")],
      favorite_videos: [cover("new-4", "2026-08-01T13:00:00Z"), cover("new-5", "2026-07-31T12:00:00Z")],
    };

    // 时间降序去重(same-video 与 duplicate 同 videoId 被去掉); 上限是 BOOK_PAGE_COUNT(书页数)
    expect(selectBookCoverUris(records)).toEqual([
      "https://p3.douyinpic.com/new-1.jpg",
      "https://p3.douyinpic.com/new-2.jpg",
      "https://p3.douyinpic.com/duplicate.jpg",
      "https://p3.douyinpic.com/new-3.jpg",
      "https://p3.douyinpic.com/new-4.jpg",
      "https://p3.douyinpic.com/old.jpg",
      "https://p3.douyinpic.com/new-5.jpg",
    ]);
    expect(selectBookCoverUris(records, true)).toEqual([]);
  });

  it("counts group summaries without treating group bodies as friend content", () => {
    const records: PersonalRecordCollection = { watch_history: [], liked_videos: [], favorite_videos: [] };
    const chats: ChatMessage[] = [{
      id: "friend-1",
      conversationId: "friend-1",
      conversationType: "friend",
      conversationName: null,
      senderId: null,
      senderName: null,
      sentAt: "2026-08-21T12:20:00+08:00",
      type: "text",
      text: "好友消息",
      mediaUrl: null,
      share: null,
      callDurationSeconds: null,
    }, {
      id: "group-body-1",
      conversationId: "group-1",
      conversationType: "group",
      conversationName: "测试群",
      senderId: null,
      senderName: null,
      sentAt: "2026-08-21T12:21:00+08:00",
      type: "text",
      text: "不应参与好友节奏",
      mediaUrl: null,
      share: null,
      callDurationSeconds: null,
    }];
    const model = buildReportModel(records, chats, null, [{
      id: "group-1",
      kind: "group",
      name: "测试群",
      messageCount: 12,
      ownMessageCount: 3,
    }]);

    expect(model.chat).toBe(13);
    expect(model.chatGroupMessages).toBe(12);
    expect(model.chatOwnGroupMessages).toBe(3);
    expect(model.chatKinds).toEqual([expect.objectContaining({ name: "文字", count: 1 })]);
    expect(model.chatGroups).toHaveLength(1);
  });
});

describe("涡旋粒子", () => {
  it("整段生命周期都留在圆锥内，且越靠焦点转得越快", () => {
    const dots = spawnVortex(120);
    const band = [{ angle: 0, frames: 0 }, { angle: 0, frames: 0 }];
    for (let frame = 0; frame < 900; frame += 1) {
      for (const dot of dots) {
        const before = dot.theta;
        const slot = dot.u / 356 > 0.6 ? 0 : dot.u / 356 < 0.15 ? 1 : -1;
        stepVortex(dot, 1 / 60, frame / 60);
        // theta 变小 = 这一帧重生了，不计入角速度
        if (slot >= 0 && dot.theta > before) {
          band[slot]!.angle += dot.theta - before;
          band[slot]!.frames += 1;
        }
        const view = vortexFrame(dot);
        expect(Math.abs(view.cx - 190)).toBeLessThanOrEqual(0.44 * (376 - view.cy) + 20);
        // 最上一层圆盘在锥口平面上方，落在暗腔里甚至锥口以外是预期的（预览也这样）
        expect(view.cy).toBeGreaterThan(0);
        expect(view.cy).toBeLessThanOrEqual(380);
        expect(view.r).toBeGreaterThan(0);
      }
    }
    const omega = band.map((row) => row.angle / row.frames);
    // 焦点附近角速度必须显著高于锥口，否则只是整体刚性旋转
    expect(omega[1]! / omega[0]!).toBeGreaterThan(2);
  });
});

describe("segmentEdgeClip", () => {
  const ys = (clip: string) => clip.slice(8, -1).split(", ").map((pt) => pt.split(" ").map((v) => Number(v.replace("%", ""))) as [number, number]);

  it("相邻片在交界处上下缘对齐（缝上不留台阶）", () => {
    for (let k = 0; k < 11; k += 1) {
      const a = ys(segmentEdgeClip(k));
      const b = ys(segmentEdgeClip(k + 1));
      // a 的最右顶点（上缘末点 / 下缘首点）应与 b 的最左顶点同高
      expect(a[8]![1]).toBeCloseTo(b[0]![1], 2); // 上缘
      expect(a[9]![1]).toBeCloseTo(b[17]![1], 2); // 下缘
    }
  });

  it("毛边有起伏但不越界", () => {
    const all = Array.from({ length: 12 }, (_, k) => ys(segmentEdgeClip(k))).flat();
    const top = all.filter((pt) => pt[1] < 50).map((pt) => pt[1]);
    expect(Math.max(...top) - Math.min(...top)).toBeGreaterThan(0.8); // 确实在抖（纸边只留轻微毛刺，不规则边界由烘焙的颜料渗透边负责）
    expect(Math.min(...top)).toBeGreaterThan(0); // 没抖出页面
    expect(Math.max(...all.map((pt) => pt[1]))).toBeLessThan(100);
  });
});
