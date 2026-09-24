import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform, type ImageStyle, type View, type ViewStyle } from "react-native";

/**
 * 工作台各页共用的一小套动效：进场上浮、滚动到视口再出现、悬停抬起、活体信号脉冲、数字滚动、图形画出。
 * web 上靠 data-* 属性接 CSS（见 motionCss，随 ensureThemeStyles 注入一次）；native 全部是空操作。
 * 参考 landing.love 一类站点的手法：错开的上浮进场、卡片悬停微抬、封面悬停微放、计数器。
 */
const web = Platform.OS === "web";
const EASE = "cubic-bezier(.22,.61,.36,1)";

export const motionCss = `
@keyframes ws-rise{from{opacity:0;transform:translate3d(0,18px,0)}to{opacity:1;transform:none}}
@keyframes ws-fade{from{opacity:0}to{opacity:1}}
@keyframes ws-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ws-signal) 60%,transparent)}100%{box-shadow:0 0 0 9px transparent}}
@keyframes ws-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.15);opacity:1}100%{transform:scale(1)}}
@keyframes ws-slide{from{transform:translateX(-100%)}to{transform:translateX(320%)}}
[data-motion="rise"]{animation:ws-rise .7s ${EASE} backwards}
[data-motion="fade"]{animation:ws-fade .55s ease-out backwards}
[data-motion="pulse"]{animation:ws-pulse 1.7s cubic-bezier(.2,.6,.3,1) infinite}
[data-motion="slide"]{animation:ws-slide 1.4s cubic-bezier(.4,0,.2,1) infinite}
[data-motion="pop"]{animation:ws-pop .45s cubic-bezier(.2,.8,.3,1.2) backwards}
[data-reveal="wait"][data-reveal]{opacity:0}
[data-reveal="in"]{animation:ws-rise .8s ${EASE} backwards}
${Array.from({ length: 16 }, (_, index) => `[data-i="${index + 1}"]{animation-delay:${(index + 1) * 70}ms}`).join("")}
[data-hover]{transition:transform .4s ${EASE},box-shadow .4s ${EASE},background-color .3s,border-color .3s,opacity .25s}
[data-hover] svg{transition:transform .35s ${EASE}}
[data-hover="lift"]:hover{transform:translateY(-3px);box-shadow:0 12px 26px -14px rgba(0,0,0,.45)}
[data-hover="card"]:hover{transform:translateY(-4px) scale(1.015);box-shadow:0 16px 32px -16px rgba(0,0,0,.5)}
[data-hover="raise"]:hover{transform:translateY(-1px)}
[data-hover="raise"]:hover svg{transform:translateX(3px)}
[data-hover="tint"]:hover{background-color:color-mix(in srgb,var(--ws-text) 7%,transparent)}
@media (prefers-reduced-motion:reduce){[data-motion],[data-reveal]{animation:none!important;opacity:1!important}[data-hover],[data-hover] svg{transition:none!important}}
`;

type Motion = "rise" | "fade" | "pulse" | "slide" | "pop";
type Hover = "lift" | "card" | "raise" | "tint";

function reduced(): boolean {
  return web && typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 一个元素上的动效标记：进场种类、错开序号（1–16，每级 70ms）、悬停反馈、是否已进入视口。
 * ws 是版式角色（空格分隔，可带状态词如 "btn on"），只有海报和内容年志的版式层认它（见 posterCss / traceCss），档案馆不受影响。
 */
export function fx(set: { motion?: Motion | false | null; i?: number; hover?: Hover; reveal?: boolean; ws?: string }): { dataSet?: Record<string, string> } {
  if (!web) return {};
  const dataSet: Record<string, string> = {};
  if (set.motion) dataSet.motion = set.motion;
  if (set.reveal !== undefined) dataSet.reveal = set.reveal ? "in" : "wait";
  if (set.i) dataSet.i = String(Math.min(16, set.i));
  if (set.hover) dataSet.hover = set.hover;
  if (set.ws) dataSet.ws = set.ws;
  return { dataSet };
}

/** 只带版式角色的标记：ws("btn")、ws("tile", on && "on")。 */
export function ws(...roles: Array<string | false | null | undefined>): { dataSet?: Record<string, string> } {
  return fx({ ws: roles.filter(Boolean).join(" ") || undefined });
}

/** 状态驱动的过渡（悬停放大、进度条宽度、开关滑块）。 */
export function ease(props: string, ms = 400): ViewStyle | null {
  return web ? ({ transitionProperty: props, transitionDuration: `${ms}ms`, transitionTimingFunction: EASE } as unknown as ViewStyle) : null;
}
/** 同上，给 Image / ImageBackground 的 imageStyle 用。 */
export function easeImage(props: string, ms = 400): ImageStyle | null {
  return ease(props, ms) as unknown as ImageStyle | null;
}

/** 节点第一次进入视口时翻 true；不支持 IntersectionObserver 或 native 时直接 true。 */
export function useInView<T extends View>(existing?: RefObject<T | null>): [RefObject<T | null>, boolean] {
  const own = useRef<T | null>(null);
  const ref = existing ?? own;
  const [inView, setInView] = useState(!web);
  useEffect(() => {
    const node = ref.current as unknown as Element | null;
    if (!web || !node || typeof IntersectionObserver === "undefined" || reduced()) {
      setInView(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setInView(true);
      observer.disconnect();
    // 上方放宽一屏：快速滚过去的元素也算"已出现"，回头看不会在视口顶边上凭空冒出来
    }, { rootMargin: "100% 0px -6% 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return [ref, inView];
}

/** active 变 true 后 0→1 的缓出进度（画图形用）；native 或减少动态偏好下恒为 1。 */
export function useTween(active: boolean, duration = 900): number {
  const instant = !web || reduced();
  const [t, setT] = useState(instant ? 1 : 0);
  useEffect(() => {
    if (instant || !active) return undefined;
    let frame = 0;
    const start = performance.now();
    // rAF 给的帧时间可能早于这里的 start，不夹住的话负进度会让动画先往反方向跳一下
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      setT(1 - (1 - p) ** 3);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, duration, instant]);
  return t;
}

/** 进入视口后再画：返回挂在图形根节点的 ref 和 0→1 的进度。 */
export function useDraw<T extends View>(duration = 900): [RefObject<T | null>, number] {
  const [ref, inView] = useInView<T>();
  return [ref, useTween(inView, duration)];
}

/** 数字从上一次显示值滚到新值（首次从 0 起）。 */
export function useCountUp(value: number, duration = 800): number {
  const instant = !web || reduced();
  const [shown, setShown] = useState(instant ? value : 0);
  const current = useRef(shown);
  useEffect(() => {
    if (instant) {
      setShown(value);
      return undefined;
    }
    const begin = current.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      const next = begin + (value - begin) * (1 - (1 - p) ** 3);
      current.current = next;
      setShown(next);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration, instant]);
  return Math.round(shown);
}

/** 折线的近似长度，给 stroke-dash 画线用。 */
export function polylineLength(points: Array<[number, number]>): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1]!;
    const [x1, y1] = points[index]!;
    length += Math.hypot(x1 - x0, y1 - y0);
  }
  return length * 1.08;
}
