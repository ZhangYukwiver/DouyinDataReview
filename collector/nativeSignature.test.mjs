import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativeABogus, nativeSignedUrl } from "./nativeSignature.mjs";
import { sm3Digest } from "./sm3.mjs";

const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
describe("portable native signatures", () => {
  it("matches the SM3 published abc vector and Node's independent implementation across block boundaries", () => {
    expect(sm3Digest("abc").toString("hex")).toBe("66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0");
    for (const input of ["", "抖音😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)])
      expect(sm3Digest(input)).toEqual(createHash("sm3").update(input).digest());
  });
  it("matches the upstream Python A-Bogus vector with a fixed clock and random stream", () => {
    const result = nativeABogus("device_platform=webapp&aid=6383&keyword=%E7%8C%AB", { body: "count=10&cursor=0", userAgent, now: 1791684000000, rng: () => .5 });
    expect(result).toBe("O7UfhzU7dNmfCdMbuKJsSHPUG99MrPSybTToWuHTSPzJL1tT1SNXTb33JFxgsTo0fbB0we3HzxupbDVPqsWfsK9pKmpDuOhWVGVnIgXL0qwXTts/LqmiehhFwwsC0mJN-5C-E1gRIs0xIjVR9qVplB/aH5Fq5cDgRrpVp/byCEA6DA8kkx-zO9hkLg5D");
    expect(() => nativeABogus("", { userAgent, now: 1791684000 })).toThrow("invalid_signature_input");
  });
  it("encodes the exact query it signs and percent-encodes signature padding", () => {
    const result = nativeSignedUrl("https://www.douyin.com/aweme/v1/web/aweme/detail/?keyword=%E7%8C%AB+%21%28%29", { userAgent });
    expect(result).toContain("keyword=%E7%8C%AB%20!()");
    expect(new URL(result).searchParams.get("a_bogus")).toMatch(/^[\w/=-]{64,512}$/u);
  });
});
