import { describe, expect, it } from "vitest";

import type { EditSegment, EditTrack } from "../../services/aiEdit";
import {
  addRefs, composerRefLabel, hideOpenRef, plainReplyRefs, refRequest, refsCaption, replyRefLabel, sendableRefs, snapToFrame, splitReplyRefs, type ComposerRef,
} from "./aiEditRefs";

const S = 1_000_000;
const words: EditSegment = { id: "t1", kind: "text", text: "周末去海边", timeline: { start_us: 0, duration_us: 2 * S } };
const clip: EditSegment = {
  id: "v1", kind: "video", path: "/m/a.mp4", timeline: { start_us: 2 * S, duration_us: 3 * S }, source: { start_us: 0, duration_us: 3 * S }, volume: 1, speed: 1, material_name: "a.mp4",
};
const tracks: EditTrack[] = [
  { id: "V", track_type: "video", name: "Video", mute: false, segments: [clip] },
  { id: "T", track_type: "text", name: "Text", mute: false, segments: [words] },
];
const project = { tracks };
const nameOf = (segment: EditSegment) => (segment.kind === "text" ? `文字“${segment.text}”` : "视频“a”");

describe("输入框上方的引用", () => {
  it("重复的不加，满 10 条以后的丢掉并数出来", () => {
    const first = addRefs([], [{ kind: "clip", clipId: "v1" }, { kind: "time", timeUs: 3 * S }, { kind: "clip", clipId: "v1" }]);
    expect(first).toEqual({ refs: [{ kind: "clip", clipId: "v1" }, { kind: "time", timeUs: 3 * S }], dropped: 0 });
    const many: ComposerRef[] = Array.from({ length: 12 }, (_, index) => ({ kind: "media", mediaId: `m${index}` }));
    const full = addRefs(first.refs, many);
    expect(full.refs).toHaveLength(10);
    expect(full.dropped).toBe(4);
    // 已经有的那条不算在丢掉的里
    expect(addRefs(full.refs, [{ kind: "clip", clipId: "v1" }, { kind: "media", mediaId: "new" }]).dropped).toBe(1);
  });

  it("换成请求里的样子", () => {
    expect([{ kind: "clip", clipId: "v1" }, { kind: "time", timeUs: 5 }, { kind: "media", mediaId: "m" }].map((ref) => refRequest(ref as ComposerRef)))
      .toEqual([{ kind: "clip", clip_id: "v1" }, { kind: "time", time_us: 5 }, { kind: "media", media_id: "m" }]);
  });

  it("这一刻落到整帧上", () => {
    expect(snapToFrame(3_210_000, 30)).toBe(3_200_000);
    expect(snapToFrame(3_240_000, 30)).toBe(3_233_333);
    expect(snapToFrame(-5, 30)).toBe(0);
    expect(snapToFrame(1_010_000, 0)).toBe(1_000_000);
  });

  it("小条上的说法跟着工程走，找不到了照实说", () => {
    const media = (id: string) => (id === "m1" ? "logo" : null);
    expect(composerRefLabel({ kind: "clip", clipId: "t1" }, project, nameOf, media)).toBe("文字“周末去海边”");
    expect(composerRefLabel({ kind: "clip", clipId: "gone" }, project, nameOf, media)).toBe("已经不在时间线上的一段");
    expect(composerRefLabel({ kind: "time", timeUs: 3_233_333 }, project, nameOf, media)).toBe("第 3.2 秒");
    expect(composerRefLabel({ kind: "media", mediaId: "m1" }, project, nameOf, media)).toBe("素材“logo”");
    expect(composerRefLabel({ kind: "media", mediaId: "m2" }, null, nameOf, media)).toBe("已经删掉的素材");
  });

  it("引用以后片子剪短了：片尾之后的时刻标出来，发的时候不带", () => {
    const media = () => null;
    expect(composerRefLabel({ kind: "time", timeUs: 5 * S }, project, nameOf, media)).toBe("第 5 秒");
    expect(composerRefLabel({ kind: "time", timeUs: 5 * S + 1 }, project, nameOf, media)).toBe("第 5 秒（已经超过片尾，不会发出去）");
    const refs: ComposerRef[] = [{ kind: "time", timeUs: 5 * S }, { kind: "time", timeUs: 18 * S }, { kind: "clip", clipId: "gone" }, { kind: "media", mediaId: "m" }];
    expect(sendableRefs(refs, project)).toEqual([refs[0], refs[2], refs[3]]);
    expect(sendableRefs(refs, null)).toEqual(refs);
  });

  it("气泡下面那行小字", () => {
    expect(refsCaption([{ kind: "clip", clip_id: "v1", label: "视频“a”" }, { kind: "time", time_us: 1, label: "第 3.2 秒" }])).toBe("引用了视频“a”、第 3.2 秒");
    expect(refsCaption([])).toBeNull();
    expect(refsCaption(undefined)).toBeNull();
  });
});

describe("回复里的引用", () => {
  it("拆出片段和时间，全角冒号、空格、带「秒」都认", () => {
    expect(splitReplyRefs("把[[片段:v1]]挪到 [[时间：3.5]] 之后，标题放在[[ 时间 : 12 秒 ]]")).toEqual([
      { kind: "text", text: "把" }, { kind: "clip", clipId: "v1" }, { kind: "text", text: "挪到 " }, { kind: "time", timeUs: 3_500_000 },
      { kind: "text", text: " 之后，标题放在" }, { kind: "time", timeUs: 12 * S },
    ]);
  });

  it("时间链接外面又写了「第」「秒」时并进链接，不会读成「第 第 3.5 秒」", () => {
    expect(splitReplyRefs("第 [[时间：3.5]] 附近，第[[时间:8]]秒处")).toEqual([
      { kind: "time", timeUs: 3_500_000 }, { kind: "text", text: " 附近，" }, { kind: "time", timeUs: 8 * S }, { kind: "text", text: "处" },
    ]);
    // 片段链接前后的字不动
    expect(splitReplyRefs("第[[片段:v1]]秒")).toEqual([{ kind: "text", text: "第" }, { kind: "clip", clipId: "v1" }, { kind: "text", text: "秒" }]);
  });

  it("写得不对的原样留着", () => {
    expect(splitReplyRefs("[[时间:三秒]] 和 [[片段:a b]] 还有 [[别的:x]]")).toEqual([{ kind: "text", text: "[[时间:三秒]] 和 [[片段:a b]] 还有 [[别的:x]]" }]);
    expect(splitReplyRefs("")).toEqual([]);
    expect(splitReplyRefs("没有引用")).toEqual([{ kind: "text", text: "没有引用" }]);
  });

  it("流式输出时藏起没闭合的「[[…」，换行以后的不藏", () => {
    expect(hideOpenRef("把[[片段:v")).toBe("把");
    expect(hideOpenRef("把[[片段:v1]")).toBe("把");
    expect(hideOpenRef("把[[片段:v1]]挪到[")).toBe("把[[片段:v1]]挪到");
    expect(hideOpenRef("把[[片段:v1]]挪到")).toBe("把[[片段:v1]]挪到");
    expect(hideOpenRef("数组 [[1, 2]\n下一行")).toBe("数组 [[1, 2]\n下一行");
  });

  it("显示成人话，找不到的片段不能点", () => {
    expect(replyRefLabel({ kind: "clip", clipId: "v1" }, project, nameOf)).toEqual({ label: "视频“a”", found: true });
    expect(replyRefLabel({ kind: "clip", clipId: "gone" }, project, nameOf)).toEqual({ label: "前面提到的一段", found: false });
    expect(replyRefLabel({ kind: "time", timeUs: 65_200_000 }, project, nameOf)).toEqual({ label: "第 1 分 5.2 秒", found: true });
    expect(plainReplyRefs("把[[片段:v1]]放到[[时间:2]]", (piece) => replyRefLabel(piece, project, nameOf).label)).toBe("把视频“a”放到第 2 秒");
  });
});
