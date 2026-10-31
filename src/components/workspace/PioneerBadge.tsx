import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Platform } from "react-native";

import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

/**
 * 先驱者徽章：侧栏空白处一枚迷你银章，悬停在侧边显示一段话；点它（或第一次进工作台）弹出一张横版会员卡。
 * 会员卡：左半浅色底板上一枚压印银章——外圈一圈表盘刻度（软件做的是「回顾」，图标本身也是回放箭头）、正中凸起的软件图标、下面压一行 PIONEER；
 * 右半「DouyinDataReview / 先驱者 / 早期使用者徽章」和获得日期、反馈 Q 群两行。卡下那段话 + 工作台自己的胶囊按钮（复制群号、关闭）。
 * 卡片从侧栏银章的位置飞出来，打开后跟鼠标轻轻偏转。只在 web（桌面版）上有。
 * 用户嫌过、别再加：天降三连转/震屏/闪白/火花/光晕（「动画过了」「不要炫光」）、钞票花纹/渐变印刷（「变丑了」）；
 * 参考过别家的会员卡，用户要求「不要照搬」：不用环形字、斜纹底、Time: 标签、手写签名、黑色圆按钮。
 */
const SEEN_KEY = "dy2.pioneerBadge";
const SINCE_KEY = "dy2.pioneerSince";
const GROUP = "1124211302";
const NOTE = "感谢您的使用，方便的话请将您的问题向群聊或者作者反馈，我非常期待与您的交流，这对个人创作者非常宝贵";
// 群号整段不折行，别断成「群 / 号：」
const note = <>{NOTE}<span style={{ whiteSpace: "nowrap" }}>「群号：{GROUP}」</span></>;

const INK = color.accentAction;

// 图标原图 64 格的线（照 build/icon.png 描）
const ICON_PATHS = [
  "M33.5 12V28C33.5 29.5 34.5 30 36 29.6C44 28 49.6 25.5 49.6 20.5C49.6 14.5 42 11 36 10.8C34.5 10.7 33.5 11 33.5 12Z",
  "M32.3 49.5A10.5 10.5 0 1 1 34.9 38.4",
  "M29.6 38.6L32 44L37 40.6",
];
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8.5 7 48 48"><g fill="none" stroke="#000" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;
const ICON_MASK = `url("data:image/svg+xml,${encodeURIComponent(ICON_SVG)}") center/contain no-repeat`;

// 银章外圈的表盘刻度：60 格，每 5 格一道长的
const TICKS = Array.from({ length: 60 }, (_, k) => {
  const angle = (k * Math.PI) / 30;
  const inner = k % 5 === 0 ? 73 : 79;
  const point = (r: number) => `${(100 + r * Math.sin(angle)).toFixed(2)} ${(100 - r * Math.cos(angle)).toFixed(2)}`;
  return { d: `M${point(inner)}L${point(85)}`, major: k % 5 === 0 };
});
const MINOR_TICKS = TICKS.filter((tick) => !tick.major).map((tick) => tick.d).join("");
const MAJOR_TICKS = TICKS.filter((tick) => tick.major).map((tick) => tick.d).join("");

const metal = "radial-gradient(circle at 50% 36%,#fdfdfd 0,#eeeeee 44%,#d8d8d8 70%,#ebebeb 86%,#c4c4c4 100%)";
// 拉丝金属：几道很淡的对称反光带，静止不动
const brushed = "conic-gradient(from 20deg,rgba(255,255,255,.6),rgba(255,255,255,0) 10%,rgba(0,0,0,.05) 25%,rgba(255,255,255,0) 40%,rgba(255,255,255,.6) 50%,rgba(255,255,255,0) 60%,rgba(0,0,0,.05) 75%,rgba(255,255,255,0) 90%,rgba(255,255,255,.6))";
const mix = (token: string, percent: number) => `color-mix(in srgb, ${token} ${percent}%, transparent)`;

const css = `
.pb-btn{all:unset;position:relative;box-sizing:border-box;display:block;cursor:pointer;width:40px;height:40px;background:${brushed},${metal};transition:transform .3s cubic-bezier(.22,.61,.36,1)}
.pb-btn::before{content:"";position:absolute;inset:4px;border-radius:50%;border:.8px dashed rgba(0,0,0,.16)}
.pb-btn:hover,.pb-btn:focus-visible{transform:translateY(-2px) rotate(-8deg)}
.pb-btn:focus-visible{outline:2px solid ${INK};outline-offset:3px}
.pb-btn i{position:absolute;inset:27%;background:#7a7a7a;-webkit-mask:${ICON_MASK};mask:${ICON_MASK};filter:drop-shadow(0 1px 0 rgba(255,255,255,.9))}
@keyframes pb-fade{from{opacity:0}to{opacity:1}}
@keyframes pb-fly{from{transform:translate(var(--x0,0px),var(--y0,40px)) scale(var(--s0,.6))}to{transform:none}}
.pb-overlay{position:fixed;inset:0;z-index:10070;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;background:linear-gradient(${mix(color.surfaceRaised, 86)},${mix(color.surfaceRaised, 86)}),linear-gradient(${color.scrim},${color.scrim}),${color.scrim};animation:pb-fade .25s ease-out both;cursor:default;font-family:${font.body}}
.pb-fly{width:min(460px,calc(100vw - 48px));animation:pb-fly .5s cubic-bezier(.2,.8,.2,1) both}
.pb-card{display:flex;height:248px;overflow:hidden;border:1px solid ${color.border};border-radius:16px;background:linear-gradient(${color.surface},${color.surface}) ${color.black};box-shadow:0 0 48px rgba(0,0,0,.08),0 18px 40px -20px rgba(0,0,0,.22);color:${color.text};transform:perspective(1000px) rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:transform .3s ease-out}
.pb-plate{flex:0 0 46%;display:flex;align-items:center;justify-content:center;border-right:1px solid ${color.border};background:${color.surfaceMuted}}
.pb-disc{position:relative;width:172px;aspect-ratio:1;background:${brushed},${metal}}
/* 海报风格把所有圆角和投影都清零（posterCss 的 !important），银章得留圆的，所以这两条要压过它 */
html:root[data-style] .pb-btn{border-radius:50%!important;box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 3px 6px -2px rgba(0,0,0,.25),inset 0 1px 1px rgba(255,255,255,.9),inset 0 -2px 3px rgba(0,0,0,.1)!important;}
html:root[data-style] .pb-disc{border-radius:50%!important;box-shadow:0 14px 26px -12px rgba(0,0,0,.32),0 2px 4px rgba(0,0,0,.08),inset 0 2px 2px rgba(255,255,255,.95),inset 0 -4px 9px rgba(0,0,0,.1)!important}
.pb-disc svg{position:absolute;inset:0;width:100%;height:100%}
.pb-info{flex:1;display:flex;flex-direction:column;padding:24px 24px 22px}
.pb-brand{font-family:${font.mono};font-size:11px;letter-spacing:.06em;color:${color.textMuted}}
.pb-title{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:30px;font-weight:500;line-height:1.15}
.pb-new{padding:2px 8px;border-radius:999px;background:${color.greenSoft};color:${INK};font-size:11px;font-weight:500;line-height:1.5}
.pb-sub{margin-top:6px;font-size:13px;color:${color.textSecondary}}
.pb-rows{margin-top:auto;border-top:1px solid ${color.border};padding-top:12px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12px}
.pb-rows dt{color:${color.textMuted}}
.pb-rows dd{margin:0;font-family:${font.mono};color:${color.text};user-select:text}
.pb-note{max-width:min(440px,100%);margin:0;font-size:13px;line-height:1.7;text-align:center;color:${color.textSecondary};user-select:text;animation:pb-fade .4s .35s ease-out both}
.pb-actions{display:flex;gap:10px;animation:pb-fade .4s .45s ease-out both}
.pb-pill{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 18px;border-radius:999px;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .2s}
.pb-pill:hover{opacity:.86}
.pb-pill:focus-visible{outline:2px solid ${INK};outline-offset:2px}
.pb-pill svg{width:15px;height:15px}
.pb-primary{background:${color.button};color:${color.buttonText}}
.pb-secondary{background:${color.surface};color:${color.text};box-shadow:inset 0 0 0 1px ${color.frame}}
@media (prefers-reduced-motion:reduce){.pb-overlay,.pb-overlay *,.pb-btn{animation:none!important;transition:none!important}}
`;

// 银章：刻度、内圈和图标画在 200×200 里，压印感靠一道向上的白边 + 一道向下的暗影
function Medal() {
  return (
    <div aria-hidden className="pb-disc">
      <svg viewBox="0 0 200 200">
        <defs>
          <filter id="pb-emboss" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="-.7" floodColor="#fff" floodOpacity=".95" stdDeviation=".2" />
            <feDropShadow dx="0" dy="1.2" floodColor="#000" floodOpacity=".25" stdDeviation=".7" />
          </filter>
          <filter id="pb-relief" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="3" floodColor="#000" floodOpacity=".16" stdDeviation="2.4" />
            <feDropShadow dx="0" dy="-1" floodColor="#fff" floodOpacity="1" stdDeviation=".3" />
          </filter>
        </defs>
        <g fill="none" filter="url(#pb-emboss)" stroke="#9b9b9b" strokeLinecap="round">
          <circle cx="100" cy="100" r="91" strokeOpacity=".5" strokeWidth=".9" />
          <path d={MINOR_TICKS} strokeWidth="1.1" />
          <path d={MAJOR_TICKS} stroke="#858585" strokeWidth="2.6" />
          <circle cx="100" cy="100" r="66" strokeOpacity=".45" strokeWidth=".9" />
        </g>
        <g fill="none" filter="url(#pb-relief)" stroke="#fdfdfd" strokeLinecap="round" strokeLinejoin="round" strokeWidth="6.2" transform="translate(100 92) scale(1.25) translate(-32 -31.5)">
          {ICON_PATHS.map((d) => <path key={d} d={d} />)}
        </g>
        <text fill="#8d8d8d" filter="url(#pb-emboss)" fontSize="9" fontWeight="700" letterSpacing="3.2" textAnchor="middle" x="101.6" y="148">PIONEER</text>
      </svg>
    </div>
  );
}

const copyIcon = (
  <svg aria-hidden fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24">
    <rect height="12" rx="2" width="12" x="8" y="8" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);
const checkIcon = (
  <svg aria-hidden fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.1" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
}

function readSeen(): boolean {
  try { return globalThis.localStorage?.getItem(SEEN_KEY) === "1"; } catch { return true; } // 存储读不到就别每次都弹
}

// 第一次看到徽章的那天就是获得日期
function readSince(): string {
  try {
    const saved = globalThis.localStorage?.getItem(SINCE_KEY);
    if (saved) return saved.replaceAll("/", "."); // 上一版存过 2026/10/30
    globalThis.localStorage?.setItem(SINCE_KEY, today());
  } catch { /* 存不下就显示今天 */ }
  return today();
}

export function PioneerBadge() {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [since] = useState(readSince);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  // fresh = 第一次进来自动弹的那一次，标题旁挂「新获得」
  const [open, setOpen] = useState<null | { fresh: boolean }>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (readSeen()) return;
    try { globalThis.localStorage?.setItem(SEEN_KEY, "1"); } catch { /* 存不下就下次再弹 */ }
    const timer = setTimeout(() => setOpen({ fresh: true }), 700); // 等工作台淡入完再弹
    return () => clearTimeout(timer);
  }, []);

  // 在徽章墙里拖它时收不到 mouseleave，说明会一直挂着
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    document.addEventListener("dragstart", hide);
    return () => document.removeEventListener("dragstart", hide);
  }, [tip]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 卡片从侧栏银章的位置飞出来：量出两者的中心差和大小比，交给 pb-fly 的起点
  useLayoutEffect(() => {
    const fly = flyRef.current;
    const from = buttonRef.current?.getBoundingClientRect();
    if (!open || !fly || !from?.width) return;
    const to = fly.getBoundingClientRect();
    fly.style.setProperty("--x0", `${from.left + from.width / 2 - (to.left + to.width / 2)}px`);
    fly.style.setProperty("--y0", `${from.top + from.height / 2 - (to.top + to.height / 2)}px`);
    fly.style.setProperty("--s0", (from.height / to.height).toFixed(3));
  }, [open]);

  if (Platform.OS !== "web" || typeof document === "undefined") return null;

  const showTip = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setTip({ left: rect.right + 12, top: Math.max(12, rect.top + rect.height / 2) });
  };
  // 卡片跟着鼠标轻轻偏转（最多 6°）；按鼠标离中心多远占半个窗口算
  const tilt = (event: React.MouseEvent | null) => {
    const node = cardRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const dx = event ? Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / (window.innerWidth / 2))) : 0;
    const dy = event ? Math.max(-1, Math.min(1, (event.clientY - rect.top - rect.height / 2) / (window.innerHeight / 2))) : 0;
    node.style.setProperty("--ry", `${(dx * 6).toFixed(2)}deg`);
    node.style.setProperty("--rx", `${(-dy * 6).toFixed(2)}deg`);
  };
  const copyGroup = () => {
    void globalThis.navigator?.clipboard?.writeText(GROUP).then(() => setCopied(true), () => undefined);
  };

  // 外面那一格（.pb-tile）由徽章墙 BadgeWall 套，它管顺序和拖动
  return (
    <>
      <style>{css}</style>
      <button
        ref={buttonRef}
        aria-label="先驱者徽章"
        className="pb-btn"
        data-testid="pioneer-badge"
        onBlur={() => setTip(null)}
        onClick={() => { setTip(null); setCopied(false); setOpen({ fresh: false }); }}
        onFocus={showTip}
        onMouseEnter={showTip}
        onMouseLeave={() => setTip(null)}
        style={open ? { visibility: "hidden" } : undefined}
        type="button"
      >
        <i />
      </button>
      {tip ? createPortal(
        <div
          role="tooltip"
          style={{
            position: "fixed", left: tip.left, top: tip.top, transform: "translateY(-50%)", zIndex: 10_060, width: 248, boxSizing: "border-box",
            padding: "12px 14px", pointerEvents: "none", animation: "pb-fade .18s ease-out both",
            background: `linear-gradient(${color.surface}, ${color.surface}) ${color.black}`, border: `1px solid ${color.border}`, borderRadius: radius.medium,
            boxShadow: "0 14px 32px -16px rgba(0,0,0,.45)", fontFamily: font.body, fontSize: 13, lineHeight: 1.7, color: color.text,
          }}
        >
          <div style={{ marginBottom: 4, fontSize: 12, fontWeight: 600, letterSpacing: ".12em", color: INK }}>先驱者徽章</div>
          {note}
        </div>,
        document.body,
      ) : null}
      {open ? createPortal(
        <div
          aria-label="先驱者徽章"
          aria-modal
          className="pb-overlay"
          data-testid="pioneer-badge-overlay"
          onClick={(event) => { if (!(event.target as Element).closest(".pb-card,.pb-note,.pb-actions")) setOpen(null); }}
          onMouseLeave={() => tilt(null)}
          onMouseMove={tilt}
          role="dialog"
        >
          <div ref={flyRef} className="pb-fly">
            <div ref={cardRef} className="pb-card">
              <div className="pb-plate"><Medal /></div>
              <div className="pb-info">
                <div className="pb-brand">DouyinDataReview</div>
                <div className="pb-title">先驱者{open.fresh ? <span className="pb-new">新获得</span> : null}</div>
                <div className="pb-sub">早期使用者徽章</div>
                <dl className="pb-rows" style={{ marginBottom: 0 }}>
                  <dt>获得日期</dt><dd>{since}</dd>
                  <dt>反馈 Q 群</dt><dd>{GROUP}</dd>
                </dl>
              </div>
            </div>
          </div>
          <p className="pb-note">{NOTE}</p>
          <div className="pb-actions">
            <button className="pb-pill pb-primary" data-testid="pioneer-badge-copy" onClick={copyGroup} type="button">{copied ? checkIcon : copyIcon}{copied ? "群号已复制" : "复制群号"}</button>
            <button className="pb-pill pb-secondary" onClick={() => setOpen(null)} type="button">关闭</button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
