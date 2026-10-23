import { describe, expect, it } from "vitest";

import { MAX_PREVIEW_BYTES, describeAttachments, parseAttachments } from "./attachments.mjs";

const IMAGE = "a".repeat(32);
const VIDEO = "b".repeat(32);
const IMPORTING = "c".repeat(32);
const items = [
  { id: IMAGE, kind: "image", status: "ready", name: "封面.png" },
  { id: VIDEO, kind: "video", status: "ready", name: "海边.mp4" },
  { id: IMPORTING, kind: "image", status: "importing", name: "下载中.jpg" },
];
const library = { get: (id) => items.find((item) => item.id === id) ?? null };

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const url = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;

describe("parseAttachments", () => {
  it("takes up to four ready images from the library, each with a small JPEG, PNG or WebP preview", () => {
    expect(parseAttachments(undefined, library)).toEqual([]);
    expect(parseAttachments(null, library)).toEqual([]);
    const parsed = parseAttachments([
      { media_id: IMAGE, preview: url("image/jpeg", JPEG) },
      { media_id: IMAGE, preview: url("image/png", PNG) },
      { media_id: IMAGE, preview: url("image/webp", WEBP) },
    ], library);
    expect(parsed.map(({ media_id: id, name, mime }) => [id, name, mime])).toEqual([[IMAGE, "封面.png", "image/jpeg"], [IMAGE, "封面.png", "image/png"], [IMAGE, "封面.png", "image/webp"]]);
    expect(parsed[0].bytes.equals(JPEG)).toBe(true);
  });

  it("refuses anything else in plain words", () => {
    const bad = { code: "invalid_attachment", status: 422, message: "图片不对，换一张试试。" };
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_PREVIEW_BYTES)]);
    for (const raw of [
      "x", { media_id: IMAGE }, [null], [{ media_id: "nope", preview: url("image/jpeg", JPEG) }],
      [{ media_id: VIDEO, preview: url("image/jpeg", JPEG) }], [{ media_id: IMPORTING, preview: url("image/jpeg", JPEG) }],
      [{ media_id: IMAGE }], [{ media_id: IMAGE, preview: 3 }], [{ media_id: IMAGE, preview: url("image/gif", JPEG) }],
      [{ media_id: IMAGE, preview: "data:image/jpeg;base64," }], [{ media_id: IMAGE, preview: `${url("image/jpeg", JPEG)}#x` }],
      [{ media_id: IMAGE, preview: "https://example.com/a.jpg" }], [{ media_id: IMAGE, preview: url("image/png", JPEG) }],
      [{ media_id: IMAGE, preview: url("image/jpeg", big) }],
    ]) {
      expect(() => parseAttachments(raw, library)).toThrow(expect.objectContaining(bad));
    }
    const five = Array.from({ length: 5 }, () => ({ media_id: IMAGE, preview: url("image/jpeg", JPEG) }));
    expect(() => parseAttachments(five, library)).toThrow(expect.objectContaining({ code: "too_many_attachments", status: 422, message: "一次最多带 4 张图。" }));
  });

  it("names the images and their media ids for the model", () => {
    expect(describeAttachments([{ media_id: IMAGE, name: "封面.png" }, { media_id: VIDEO, name: "b.png" }]))
      .toBe(`用户这句话附了 2 张图：素材“封面.png”（media_id ${IMAGE}）、素材“b.png”（media_id ${VIDEO}）。图已经放进素材库，要放进时间线就用这个 media_id。`);
  });
});
