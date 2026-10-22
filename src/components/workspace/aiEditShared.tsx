import React from "react";
import { Platform } from "react-native";
import type { AiEditMediaItem, AiEditRegion, EditCanvas, EditSegment } from "../../services/aiEdit";
import { ws } from "./motion";
import { workspaceColors as color } from "./workspaceTheme";

// AI 剪辑页左栏和看板各文件共用的小零件：平台判断、悬停提示、素材称呼、片段配色、画面比例预设。
// 没有依赖看板的任何文件，看板、轨道区、画面、详情卡都从这里拿，不会互相绕圈引用。

export const web = Platform.OS === "web";
export const webPointer = web ? ({ cursor: "pointer" } as object) : null;
export const webAutoHeight = web ? ({ fieldSizing: "content" } as object) : null;
export const errorText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

/** 画面上框的一块，带着框里片段的称呼给提示用 */
export type BoardRegion = AiEditRegion & { labels: string[] };

export const CANVASES: Array<{ label: string; canvas: EditCanvas }> = [
  { label: "竖屏 9:16", canvas: { width: 1080, height: 1920, fps: 30 } },
  { label: "横屏 16:9", canvas: { width: 1920, height: 1080, fps: 30 } },
  { label: "方形 1:1", canvas: { width: 1080, height: 1080, fps: 30 } },
];
export const CANVAS_OPTIONS = CANVASES.map(({ label }) => ({ label: label.split(" ")[0]!, value: label }));
export const canvasPreset = (canvas: EditCanvas) => CANVASES.find((item) => item.canvas.width === canvas.width && item.canvas.height === canvas.height)?.label ?? null;

export const mediaTitle = (item: AiEditMediaItem) => (item.source.type === "douyin" && item.source.title) || item.name.replace(/\.[^.]+$/u, "");

export function shortTime(value: string | null | undefined): string {
  const time = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return sameDay ? `今天 ${clock}` : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`;
}

/** 片段在轨道和详情卡上的配色 */
export function clipTone(segment: EditSegment): string {
  switch (segment.kind) {
    case "video": case "image": return color.cyan;
    case "audio": return color.green;
    case "text": return color.amber;
    case "sticker": case "track_effect": return color.accent;
    default: return color.figure;
  }
}

/**
 * 网页上给按钮加悬停提示（RN-web 的 Pressable 不转发 title）。keepFocus：鼠标按下时不抢焦点，
 * 详情卡、工具栏的按钮都要这样，点完按钮焦点还在原处，接着按快捷键照样管用（C5）。
 */
export function WebTitle({ title, keepFocus = false, children }: { title?: string | null; keepFocus?: boolean; children: React.ReactNode }) {
  if (!web) return <>{children}</>;
  return <div title={title || undefined} onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined} style={{ display: "flex" }}>{children}</div>;
}

/**
 * 不能用的按钮不写 disabled，写 aria-disabled，再把原因写进 title：悬停时能看到为什么点不了（E2）。
 * 这个直接展开到 DOM 元素（div、button）上；RN 的 Pressable 用下面的 pressableDisabled。
 */
export function ariaDisabledProps(reason: string | null | undefined): { "aria-disabled"?: true; title?: string } {
  return reason ? { "aria-disabled": true, title: reason } : {};
}

/**
 * Pressable 的「不能用」：RN-web 会拿它自己的 disabled 盖掉传进去的 aria-disabled，要走 accessibilityDisabled 才写得进 DOM。
 * 不传 disabled，所以 onPress 照样会触发，要自己拦；原因用 WebTitle 包一层写进 title（Pressable 不转发 title）。
 */
export const pressableDisabled = (reason: string | null | undefined): object | null => (web && reason ? { accessibilityDisabled: true } : null);

/** 看板里的区域标记：捕获阶段的 pointerdown 按它记下最后一次按在哪（C6），可以和 ws() 的版式角色一起写。 */
export function areaProps(area: "board" | "timeline" | "stage", ...roles: Array<string | false | null | undefined>): { dataSet?: Record<string, string> } {
  if (!web) return {};
  return { dataSet: { ...(ws(...roles).dataSet ?? {}), boardArea: area } };
}
