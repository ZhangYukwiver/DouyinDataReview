import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => {
  const Component = () => null;
  return {
    ActivityIndicator: Component,
    Modal: Component,
    Platform: { OS: "web" },
    Pressable: Component,
    ScrollView: Component,
    StyleSheet: { create: <T,>(value: T) => value, absoluteFill: {} },
    Text: Component,
    useWindowDimensions: () => ({ width: 1440, height: 900 }),
    View: Component,
  };
});
vi.mock("react-native-svg", () => ({ default: () => null, Circle: () => null }));
vi.mock("lucide-react-native", () => {
  const Component = () => null;
  return Object.fromEntries(["Check", "Download", "RefreshCw", "Trash2", "UserRoundPlus", "X"].map((name) => [name, Component]));
});

import type { DesktopUpdateState } from "../../desktopRuntime";
import type { CollectorAccount } from "../../services/localCollector";
import { accountNote } from "./SettingsDialog";
// 设置面板和手绘页的更新面板共用这一条规则
import { appUpdateAction as updateActionFor } from "./setupModel";

function update(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    phase: "idle", currentVersion: "1.5.1", version: null, releaseName: null, releaseDate: null, releaseNotes: null,
    progress: null, bytesPerSecond: null, transferred: null, total: null, message: "", error: null, checkedAt: null, manualDownload: false,
    ...patch,
  };
}

describe("updateActionFor", () => {
  it("labels the button the same way as the collector page update panel", () => {
    expect(updateActionFor(update({ phase: "idle" }), false)).toEqual({ kind: "check", label: "检查更新", disabled: false });
    expect(updateActionFor(update({ phase: "up-to-date" }), false)).toEqual({ kind: "check", label: "检查更新", disabled: false });
    expect(updateActionFor(update({ phase: "checking" }), false)).toEqual({ kind: "check", label: "检查更新", disabled: true });
    expect(updateActionFor(update({ phase: "downloading" }), false)).toEqual({ kind: "check", label: "检查更新", disabled: true });
    expect(updateActionFor(update({ phase: "error" }), false)).toEqual({ kind: "check", label: "重试检查", disabled: false });
    expect(updateActionFor(update({ phase: "available" }), false)).toEqual({ kind: "download", label: "下载更新", disabled: false });
    expect(updateActionFor(update({ phase: "available", manualDownload: true }), true)).toEqual({ kind: "download", label: "去下载", disabled: false });
    expect(updateActionFor(update({ phase: "downloaded" }), false)).toEqual({ kind: "install", label: "重启并安装", disabled: false });
    expect(updateActionFor(update({ phase: "downloaded" }), true)).toEqual({ kind: "install", label: "采集完成后安装", disabled: true });
    expect(updateActionFor(update({ phase: "unsupported" }), false)).toBeNull();
  });
});

describe("accountNote", () => {
  const account = (id: string, uid: string | null, createdAt: string | null): CollectorAccount => ({ id, nickname: null, avatar: null, uid, createdAt });
  const year = new Date().getFullYear();

  it("says when the account was added", () => {
    expect(accountNote([account("a", "1", `${year}-08-03T10:00:00`)], 0)).toBe("8 月 3 日添加");
  });

  it("points out a second copy of the same Douyin account", () => {
    const rows = [account("a", "same", `${year}-08-03T10:00:00`), account("b", "same", null)];
    expect(accountNote(rows, 0)).toBe("8 月 3 日添加，和另一个是同一个抖音号");
    expect(accountNote(rows, 1)).toBe("和另一个是同一个抖音号");
  });

  it("is empty when nothing is known", () => {
    expect(accountNote([account("a", null, null)], 0)).toBe("");
    expect(accountNote([], 3)).toBe("");
  });
});
