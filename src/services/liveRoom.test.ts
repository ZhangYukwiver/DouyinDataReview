import { describe, expect, it } from "vitest";
import { DEFAULT_DANMAKU, isDanmakuBlocked, liveRoomIdFrom, normalizeDanmakuSettings, parseBlockedWords } from "./liveRoom";

describe("live room settings", () => {
  it("repairs whatever was saved before", () => {
    expect(normalizeDanmakuSettings(null)).toEqual(DEFAULT_DANMAKU);
    expect(normalizeDanmakuSettings({ enabled: false, opacity: 3, size: 8.4, speed: "warp", area: 0.3, blocked: ["  剧透 ", "", 5, "剧透"] }))
      .toEqual({ enabled: false, opacity: 1, size: 14, speed: "normal", area: 0.5, blocked: ["剧透"] });
  });

  it("splits block words and matches them regardless of case", () => {
    const blocked = parseBlockedWords("剧透，广告 、 AD,,");
    expect(blocked).toEqual(["剧透", "广告", "AD"]);
    expect(isDanmakuBlocked("加微信看 ad", blocked)).toBe(true);
    expect(isDanmakuBlocked("主播好厉害", blocked)).toBe(false);
  });

  it("only takes live.douyin.com links or room numbers", () => {
    expect(liveRoomIdFrom("https://live.douyin.com/921169302662?show_type=highlight")).toBe("921169302662");
    expect(liveRoomIdFrom("921169302662")).toBe("921169302662");
    expect(liveRoomIdFrom("https://www.douyin.com/user/self")).toBeNull();
  });
});
