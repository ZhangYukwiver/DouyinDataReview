import { describe, expect, it } from "vitest";
import { estimateMediaUrlLifetime, makeVideoMediaEvidence, pickVideoEvidenceHeaders } from "./videoEvidence.mjs";

describe("video download evidence", () => {
  it("estimates expire and issue times from supported query parameters", () => {
    expect(estimateMediaUrlLifetime("https://v.example.douyinvod.com/video.mp4?dy_q=1790671783&expire=1790682605&signature=secret"))
      .toEqual({
        issuedAt: "2026-09-29T08:49:43.000Z",
        expiresAt: "2026-09-29T11:50:05.000Z",
        lifetimeSeconds: 10_822,
        source: "query-expire",
      });
  });

  it("supports the reported zjcdn path expiry format without preserving the signed URL", () => {
    const evidence = makeVideoMediaEvidence({
      mediaUrl: "https://v3-dy-o.zjcdn.com/8520f1f8a295d9f34a7715835a0bc6e8/6ae1dc6c/video/tos/file?dy_q=1793176072&signature=secret",
      mediaSource: "detail-json",
      outcome: "downloaded",
      sha256: "A".repeat(64),
      responseHeaders: { "x-cache": "MISS", "set-cookie": "private=secret", location: "https://secret.invalid" },
    });

    expect(evidence).toMatchObject({
      kind: "media",
      host: "v3-dy-o.zjcdn.com",
      mediaSource: "detail-json",
      mediaExpiresAt: "2026-10-28T11:28:44.000Z",
      lifetimeSeconds: 10_852,
      expirySource: "zjcdn-path-hex",
      sha256: "a".repeat(64),
      headers: { "x-cache": "MISS" },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/signature|secret|location|set-cookie/iu);
  });

  it("keeps only an allowlist of cache and content headers", () => {
    expect(pickVideoEvidenceHeaders(new Headers({
      "Content-Range": "bytes 0-9/10",
      "X-Response-Cache": "MISS",
      "Set-Cookie": "session=secret",
      Location: "https://signed.example/secret",
    }))).toEqual({ "content-range": "bytes 0-9/10", "x-response-cache": "MISS" });
  });

  it("does not invent expiry values for unknown formats", () => {
    expect(estimateMediaUrlLifetime("https://example.com/video.mp4?token=secret")).toEqual({
      issuedAt: null,
      expiresAt: null,
      lifetimeSeconds: null,
      source: null,
    });
  });
});
