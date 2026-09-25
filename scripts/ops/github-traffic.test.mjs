import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import {
  buildWeeklyReport,
  percentChange,
  resolveDataDirectory,
  splitWindow,
  trafficEntries,
} from "./github-traffic.mjs";

function snapshot({ day, views, clones, stars = 6, downloads = 10, referrersAvailable = false } = {}) {
  const date = new Date(`${day}T12:00:00.000Z`);
  const daily = (values, key) => values.map((count, index) => ({
    timestamp: new Date(date.valueOf() - (values.length - index - 1) * 24 * 60 * 60 * 1000).toISOString(),
    count,
    uniques: Math.max(1, Math.ceil(count / 2)),
  }));
  return {
    schemaVersion: 1,
    capturedAt: date.toISOString(),
    repository: { fullName: "ZhangYukwiver/DouyinDataReview", stars, forks: 0, openIssues: 0, watchers: 0 },
    traffic: {
      views: { available: true, status: 200, data: { count: views.reduce((sum, value) => sum + value, 0), uniques: views.length, views: daily(views, "views") } },
      clones: { available: true, status: 200, data: { count: clones.reduce((sum, value) => sum + value, 0), uniques: clones.length, clones: daily(clones, "clones") } },
      popularPaths: { available: true, status: 200, data: [{ path: "/ZhangYukwiver/DouyinReview", title: "Overview", count: 13, uniques: 9 }] },
      referrers: referrersAvailable ? { available: true, status: 200, data: [] } : { available: false, status: 404, message: "Not Found", data: null },
    },
    releases: [{ tagName: "v0.1.9", publishedAt: date.toISOString(), draft: false, prerelease: false, downloads, assets: [] }],
  };
}

describe("GitHub traffic monitor", () => {
  it("resolves a platform-specific local data directory", () => {
    const explicitDirectory = process.platform === "win32"
      ? "C:\\tmp\\douyin-ops"
      : path.join(os.tmpdir(), "douyin-ops");
    expect(resolveDataDirectory(explicitDirectory)).toBe(path.resolve(explicitDirectory));
  });

  it("splits a 14-day series into current and previous windows", () => {
    const result = splitWindow(Array.from({ length: 14 }, (_, index) => ({ timestamp: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`, count: index + 1 })), 7);
    expect(result.current.map((entry) => entry.count)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(result.previous.map((entry) => entry.count)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("returns null instead of inventing a percentage from a zero baseline", () => {
    expect(percentChange(3, 0)).toBeNull();
    expect(percentChange(15, 10)).toBe(50);
  });

  it("emits threshold-based recommendations and missing-data warnings", () => {
    const latest = snapshot({
      day: "2026-09-25",
      views: [100, 95, 90, 80, 70, 50, 20, 10, 9, 8, 7, 6, 5, 4],
      clones: [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4],
      stars: 6,
      downloads: 10,
    });
    const previous = snapshot({
      day: "2026-09-18",
      views: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      clones: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      stars: 6,
      downloads: 10,
    });
    const report = buildWeeklyReport([previous, latest], {
      variant: { id: "poster-2025", label: "海报风格", placement: "README 首屏" },
      now: new Date("2026-09-26T12:00:00.000Z"),
    });
    expect(report).toMatch(/当前素材/);
    expect(report).toMatch(/来源接口不可用/);
    expect(report).toMatch(/旧路径/);
    expect(report).toMatch(/最近 48 小时内有新 Release/);
    expect(report).toMatch(/建议/);
    expect(report).toMatch(/\| Views \| [^|]+ \| [^|]+ \| [^|]+ \|/);
  });

  it("treats unavailable traffic endpoints as empty series", () => {
    expect(trafficEntries({ traffic: { views: { available: false } } }, "views")).toEqual([]);
  });
});
