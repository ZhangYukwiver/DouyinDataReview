import { useSyncExternalStore } from "react";

// 时间线工具栏的开关：吸附、主轨磁吸、联动、预览轴、画面上显示字幕。只在这台电脑上记着（所有剪辑共用），照 openfilm 的
// lib/timeline-prefs.ts（MIT License，Copyright (c) 2026 OpenFilm contributors）；存不了（隐私模式）就只在这次打开里有效。
// 主轨磁吸默认关：AI 剪的时间线常有故意留的空当，打开时才一次合拢。

export interface TimelinePrefs {
  /** 拖动、裁剪时吸到片段边、播放头、标记 */
  snap: boolean;
  /** 主轨（最下面的视频轨）上的片段首尾相接 */
  magnet: boolean;
  /** 字幕、画中画、音效跟着下面的主轨片段一起挪、一起删 */
  linkage: boolean;
  /** 鼠标在时间线上划过，画面跟着走（播放头不动） */
  previewAxis: boolean;
  /** 画面上显示字幕（只影响看板预览，不影响导出） */
  captions: boolean;
}

export const DEFAULT_PREFS: TimelinePrefs = { snap: true, magnet: false, linkage: true, previewAxis: false, captions: true };
const KEY = "dy2.timelinePrefs";

let current: TimelinePrefs = (() => {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as Partial<TimelinePrefs> | null;
    return { ...DEFAULT_PREFS, ...Object.fromEntries(Object.entries(saved ?? {}).filter(([key, value]) => key in DEFAULT_PREFS && typeof value === "boolean")) };
  } catch { return { ...DEFAULT_PREFS }; }
})();
const listeners = new Set<() => void>();

export const timelinePrefs = (): TimelinePrefs => current;

export function setTimelinePref<K extends keyof TimelinePrefs>(key: K, value: TimelinePrefs[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(current)); } catch { /* 存不了就只在这次有效 */ }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useTimelinePrefs(): TimelinePrefs {
  return useSyncExternalStore(subscribe, timelinePrefs, () => DEFAULT_PREFS);
}
