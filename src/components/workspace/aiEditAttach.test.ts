import { describe, expect, it } from "vitest";

import {
  adoptDraft, attachmentRequests, attachmentsPending, clearSent, dropMedia, fitWithin, isImageFile, pasteIsRichText, pastedName, patchAttachment, planAttachments, PREVIEW_MAX_CHARS,
  PREVIEW_STEPS, previewFits, settleAttachments, type AttachDraft,
} from "./aiEditAttach";
import type { ComposerRef } from "./aiEditRefs";

const draft = (key: string, extra: Partial<AttachDraft> = {}): AttachDraft => ({ key, name: `${key}.png`, image: true, progress: 0, mediaId: null, ...extra });

describe("附图的预览尺寸", () => {
  it("长边缩到上限以内，不放大", () => {
    expect(fitWithin(4032, 3024, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(1080, 1920, 1024)).toEqual({ width: 576, height: 1024 });
    expect(fitWithin(300, 200, 1024)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(5000, 1, 512)).toEqual({ width: 512, height: 1 });
  });

  it("先降质量、再缩小；整段 data URL 不超过 400KB", () => {
    for (let index = 1; index < PREVIEW_STEPS.length; index += 1) {
      const [before, after] = [PREVIEW_STEPS[index - 1]!, PREVIEW_STEPS[index]!];
      expect(after.side < before.side || (after.side === before.side && after.quality < before.quality)).toBe(true);
    }
    expect(PREVIEW_STEPS[0]!.side).toBe(1024);
    expect(previewFits(`data:image/jpeg;base64,${"A".repeat(PREVIEW_MAX_CHARS - 23)}`)).toBe(true);
    expect(previewFits(`data:image/jpeg;base64,${"A".repeat(PREVIEW_MAX_CHARS)}`)).toBe(false);
  });
});

describe("哪些文件当图带", () => {
  it("认图和素材库一致：只认 png、jpg、webp 扩展名，类型写着别的不算", () => {
    expect(isImageFile({ type: "image/png", name: "a.png" })).toBe(true);
    expect(isImageFile({ type: "image/jpeg", name: "海边.JPG" })).toBe(true);
    expect(isImageFile({ type: "", name: "a.webp" })).toBe(true);
    // 素材库只按扩展名收：没扩展名、.jfif 的传不上去
    expect(isImageFile({ type: "image/png", name: "a" })).toBe(false);
    expect(isImageFile({ type: "image/jpeg", name: "a.jfif" })).toBe(false);
    expect(isImageFile({ type: "image/svg+xml", name: "a.svg" })).toBe(false);
    expect(isImageFile({ type: "video/mp4", name: "a.png" })).toBe(false);
    expect(isImageFile({ type: "", name: "IMG_1.HEIC" })).toBe(false);
    expect(isImageFile({ type: "image/gif", name: "a.gif" })).toBe(false);
    expect(isImageFile({ name: "a.mp3" })).toBe(false);
  });

  it("一句话最多 4 张，多的和不是图的传完当素材引用", () => {
    const files = [{ type: "image/png", name: "1.png" }, { type: "video/mp4", name: "v.mp4" }, { type: "image/jpeg", name: "2.jpg" }, { type: "image/jpeg", name: "3.jpg" }];
    expect(planAttachments(2, files)).toEqual([true, false, true, false]);
    expect(planAttachments(4, files)).toEqual([false, false, false, false]);
  });

  it("素材库收不了的图不占名额", () => {
    const gifs = [1, 2, 3, 4].map((index) => ({ type: "image/gif", name: `${index}.gif` }));
    expect(planAttachments(0, [...gifs, { type: "image/png", name: "5.png" }])).toEqual([false, false, false, false, true]);
  });

  it("截图粘贴的 image.png 换个认得出的名字，本来有名字的不动", () => {
    const at = new Date(2026, 9, 22, 9, 5, 7);
    expect(pastedName("image.png", "image/png", at)).toBe("粘贴的图片 090507.png");
    expect(pastedName("", "image/jpeg", at)).toBe("粘贴的图片 090507.jpg");
    expect(pastedName("海边.jpg", "image/jpeg", at)).toBe("海边.jpg");
  });
});

describe("粘贴的是字还是图", () => {
  const preview = [{ name: "image.png", type: "image/png" }];

  it("Excel、Word 复制的字和表格顺带一张预览图：照常把字贴进去", () => {
    expect(pasteIsRichText({ text: "镜头\t时长\n开场\t3 秒", html: "<meta charset='utf-8'><table><tr><td>镜头</td><td>时长</td></tr></table>", files: preview })).toBe(true);
    expect(pasteIsRichText({ text: "第一段文案", html: "<html><body><!--StartFragment--><p>第一段文案</p><!--EndFragment--></body></html>", files: preview })).toBe(true);
  });

  it("截图只有图：当附件", () => {
    expect(pasteIsRichText({ text: "", html: "", files: preview })).toBe(false);
  });

  it("浏览器里复制图片：当附件", () => {
    // macOS：HTML 里只有一个 img，没有字
    expect(pasteIsRichText({ text: "", html: "<meta charset='utf-8'><img src=\"https://a.com/b.png\"/>", files: preview })).toBe(false);
    // Windows：还会把图片地址写成字
    const url = "https://a.com/b.png?x=1&y=2";
    expect(pasteIsRichText({ text: url, html: "<html>\r\n<body>\r\n<!--StartFragment--><img src=\"https://a.com/b.png?x=1&amp;y=2\"/><!--EndFragment-->\r\n</body>\r\n</html>", files: preview })).toBe(false);
    expect(pasteIsRichText({ text: url, html: "<div><img src=\"https://a.com/b.png?x=1&amp;y=2\"></div>", files: preview })).toBe(false);
  });

  it("从访达复制的文件有真实名字：当附件", () => {
    expect(pasteIsRichText({ text: "海边.jpg", html: "<p>海边.jpg</p>", files: [{ name: "海边.jpg", type: "image/jpeg" }] })).toBe(false);
    expect(pasteIsRichText({ text: "a", html: "<p>a</p>", files: [{ name: "image.png", type: "" }] })).toBe(false);
    expect(pasteIsRichText({ text: "a", html: "<p>a</p>", files: [] })).toBe(false);
  });
});

describe("附件传完以后", () => {
  it("当图带的留着；不当图带、画不出预览的变成素材引用", () => {
    const files = [
      draft("a", { mediaId: "m1", preview: "data:image/jpeg;base64,AA" }),
      draft("b", { mediaId: "m2", preview: null }),
      draft("c", { mediaId: "m3", image: false }),
      draft("d", { image: false }),
      draft("e", { mediaId: "m5" }),
    ];
    const settled = settleAttachments(files);
    expect(settled.mediaIds).toEqual(["m2", "m3"]);
    expect(settled.files.map((file) => file.key)).toEqual(["a", "d", "e"]);
  });

  it("没传完、预览没画好时先不发；发出去的只有带预览的图", () => {
    expect(attachmentsPending([draft("a", { mediaId: "m1", preview: "data:x" })])).toBe(false);
    expect(attachmentsPending([draft("a", { mediaId: "m1" })])).toBe(true);
    expect(attachmentsPending([draft("a", { preview: "data:x" })])).toBe(true);
    expect(attachmentsPending([])).toBe(false);
    expect(attachmentRequests([draft("a", { mediaId: "m1", preview: "data:x" }), draft("b", { mediaId: "m2" }), draft("c", { preview: "data:y" })]))
      .toEqual([{ media_id: "m1", preview: "data:x" }]);
  });
});

describe("附件有了进展", () => {
  const media = (id: string): ComposerRef => ({ kind: "media", mediaId: id });

  it("传好又不当图带的移进引用；附件已经拿掉的不动", () => {
    const start = { sessionId: "s1", files: [draft("a", { image: false }), draft("b")], refs: [] as ComposerRef[] };
    const done = patchAttachment(start, "a", { mediaId: "m1", progress: 1 });
    expect(done?.dropped).toBe(0);
    expect(done?.draft.sessionId).toBe("s1");
    expect(done?.draft.files.map((file) => file.key)).toEqual(["b"]);
    expect(done?.draft.refs).toEqual([media("m1")]);
    expect(patchAttachment(start, "b", null)?.draft.files.map((file) => file.key)).toEqual(["a"]);
    expect(patchAttachment(start, "gone", { progress: 0.5 })).toBeNull();
  });

  it("引用满了：文件照样不留在附件里，没加上的算进 dropped", () => {
    const full = Array.from({ length: 10 }, (_, index) => media(`old${index}`));
    const done = patchAttachment({ files: [draft("a", { image: false })], refs: full }, "a", { mediaId: "m1" });
    expect(done?.dropped).toBe(1);
    expect(done?.draft.files).toEqual([]);
    expect(done?.draft.refs).toHaveLength(10);
  });
});

describe("输入框上方那一排归谁、什么时候清", () => {
  const media = (id: string): ComposerRef => ({ kind: "media", mediaId: id });
  const time: ComposerRef = { kind: "time", timeUs: 3_000_000 };

  it("还没有剪辑时攒的，新建剪辑（比如先存目标）以后还在；已经有主的不动", () => {
    const loose = { sessionId: null, files: [draft("a", { mediaId: "m1", preview: "data:x" })], refs: [media("m2")] };
    expect(adoptDraft(loose, "s1")).toEqual({ ...loose, sessionId: "s1" });
    const owned = { ...loose, sessionId: "s0" };
    expect(adoptDraft(owned, "s1")).toBe(owned);
  });

  it("发出去以后拿掉发了的（包括没发出去的片尾之后的时刻），之后才加的留着", () => {
    const sentFile = draft("a", { mediaId: "m1", preview: "data:x" });
    const later = draft("b");
    const now = { sessionId: "s1", files: [sentFile, later], refs: [time, media("m2"), media("m3")] };
    const cleared = clearSent(now, [null, "s1"], { refs: [time, media("m2")], files: [sentFile] });
    expect(cleared.files.map((file) => file.key)).toEqual(["b"]);
    expect(cleared.refs).toEqual([media("m3")]);
    // 已经换成别的剪辑的那一排不动
    expect(clearSent({ ...now, sessionId: "s2" }, [null, "s1"], { refs: [time], files: [sentFile] }).refs).toHaveLength(3);
    expect(clearSent(now, ["s1"], { refs: [], files: [] })).toBe(now);
  });

  it("素材库里删了的素材：附的图和引用一起拿掉", () => {
    const now = { sessionId: "s1", files: [draft("a", { mediaId: "m1", preview: "data:x" }), draft("b", { mediaId: "m2", preview: "data:y" })], refs: [media("m1"), time] };
    const after = dropMedia(now, "m1");
    expect(after.files.map((file) => file.key)).toEqual(["b"]);
    expect(after.refs).toEqual([time]);
    expect(dropMedia(now, "m9")).toBe(now);
  });
});
