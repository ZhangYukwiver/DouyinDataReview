import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Platform } from "react-native";

import { ACHIEVEMENTS, arrangeBadges, markAchievementSeen, progressOf, setBadgeOrder, useAchievements, type AchievementGroup, type AchievementState } from "./achievements";
import { PioneerBadge } from "./PioneerBadge";
import { workspaceColors as color, workspaceFonts as font } from "./workspaceTheme";

/**
 * 侧栏的徽章墙：先驱者 + 成就（每类只摆获得的最高一档）+ 最后一格「已获得 / 38」，点开是全部成就。
 * 点奖章看收藏卡（设计稿的 SVG 原样放，左右翻已获得的）；没获得的在全部成就里灰着，标进度。没看过的新奖章右上角一个小点。
 * 除了「N/38」都能拖着换位置，顺序记在成就存档里（按类别记，升档不挪位）；新获得的接在最后。
 * 侧栏收起时只留排第一的那枚。只在 web（桌面版）上有。
 */
const TIER = ["纪念章", "I", "II", "III"];
const FILTERS: Array<[AchievementGroup | "all", string]> = [["all", "全部"], ["data", "数据采集"], ["usage", "功能使用"], ["special", "初次成就"]];
const INDEX = new Map(ACHIEVEMENTS.map((item, index) => [item.id, index]));
const serial = (id: string) => `${String(INDEX.get(id)! + 1).padStart(2, "0")} / ${ACHIEVEMENTS.length}`;
const fmt = (value: number) => value.toLocaleString("zh-CN");
const mix = (token: string, percent: number) => `color-mix(in srgb, ${token} ${percent}%, transparent)`;

const PIONEER = "pioneer";

const css = `
/* 每枚徽章占一格方块，从导航下面左上角起往右、往下排（展开时一行四格）。
   侧栏收起时只留第一格。收放时侧栏宽度要动 380ms，按宽度自动排的格子一路从四列变一列会跳来跳去，
   所以由 React 直接标 data-compact：收起一开始其余的立刻藏起来（宽度 40ms 内就会挤掉一列，来不及淡出），展开等宽度动完、在最终位置再淡入 */
.pb-slot{flex:1 1 0;min-height:0;container-type:size}
.pb-tiles{display:grid;grid-template-columns:repeat(auto-fill,44px);gap:4px;padding:24px 4px 0}
.pb-tile{width:44px;height:44px;display:flex;align-items:center;justify-content:center}
.pb-tile+.pb-tile{transition:opacity .25s .38s,visibility 0s .38s}
.pb-slot[data-compact] .pb-tile+.pb-tile{opacity:0;visibility:hidden;transition:none}
@container (max-height:68px){.pb-tiles{display:none}}
.pb-tile[draggable=true]{cursor:grab}
.pb-tile[data-dragging]{opacity:.3}
.ac-medal{all:unset;position:relative;box-sizing:border-box;display:block;width:44px;height:44px;cursor:pointer;transition:transform .3s cubic-bezier(.22,.61,.36,1)}
.ac-medal img{display:block;width:100%;height:100%;filter:drop-shadow(0 2px 2px rgba(0,0,0,.14))}
.ac-medal:hover,.ac-medal:focus-visible{transform:translateY(-2px)}
.ac-medal:focus-visible,.ac-all:focus-visible{outline:2px solid ${color.accentAction};outline-offset:2px}
.ac-dot{position:absolute;top:3px;right:3px;width:8px;height:8px;border-radius:50%;background:${color.accentAction};box-shadow:0 0 0 2px ${color.surface}}
.ac-all{all:unset;box-sizing:border-box;display:flex;align-items:baseline;justify-content:center;width:36px;height:36px;padding-top:11px;border:1px dashed ${color.frame};border-radius:50%;cursor:pointer;font-family:${font.mono};font-size:11px;color:${color.textSecondary};transition:border-color .2s,color .2s}
.ac-all small{font-size:8px;color:${color.textMuted}}
.ac-all:hover{border-color:${color.textMuted};color:${color.text}}
@keyframes ac-fade{from{opacity:0}to{opacity:1}}
@keyframes ac-rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.ac-overlay{position:fixed;inset:0;z-index:10070;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;box-sizing:border-box;background:linear-gradient(${mix(color.surfaceRaised, 86)},${mix(color.surfaceRaised, 86)}),linear-gradient(${color.scrim},${color.scrim}),${color.scrim};animation:ac-fade .25s ease-out both;font-family:${font.body};color:${color.text}}
.ac-panel{position:relative;width:min(980px,100%);max-height:100%;overflow:auto;box-sizing:border-box;padding:28px 32px 24px;border:1px solid ${color.border};border-radius:16px;background:linear-gradient(${color.surface},${color.surface}) ${color.black};box-shadow:0 0 48px rgba(0,0,0,.08),0 18px 40px -20px rgba(0,0,0,.22);animation:ac-rise .35s cubic-bezier(.2,.8,.2,1) both}
.ac-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px}
.ac-eyebrow{font-family:${font.mono};font-size:11px;letter-spacing:.14em;color:${color.textMuted}}
.ac-head h2{margin:8px 0 6px;font-size:28px;font-weight:550}
.ac-head p{margin:0;font-size:13px;color:${color.textSecondary}}
.ac-count{font-family:${font.mono};font-size:38px;line-height:1;text-align:right}
.ac-count small{display:block;margin-top:6px;font-family:${font.body};font-size:12px;color:${color.textMuted}}
.ac-bar{display:flex;gap:6px;margin-top:22px;padding:12px 0;border-top:1px solid ${color.border};border-bottom:1px solid ${color.border}}
.ac-pill{all:unset;box-sizing:border-box;padding:6px 14px;border-radius:999px;border:1px solid transparent;font-size:13px;color:${color.textSecondary};cursor:pointer}
.ac-pill[aria-pressed=true]{background:${color.surfaceMuted};border-color:${color.border};color:${color.text}}
.ac-pill:focus-visible,.ac-btn:focus-visible,.ac-tile:focus-visible{outline:2px solid ${color.accentAction};outline-offset:2px}
.ac-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:8px;padding-top:14px}
.ac-tile{all:unset;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 8px 14px;border-radius:14px;border:1px solid transparent;cursor:pointer;text-align:center;transition:background .2s,border-color .2s,transform .2s}
.ac-tile:hover{background:${color.surfaceMuted};border-color:${color.border};transform:translateY(-2px)}
.ac-tile img{width:96px;height:96px;margin-bottom:4px}
.ac-tile b{font-size:14px;font-weight:500}
.ac-tile span{font-size:11px;color:${color.textMuted}}
.ac-tile.ac-locked img{filter:grayscale(1);opacity:.4}
.ac-tile.ac-locked b{color:${color.textSecondary}}
.ac-card{width:min(860px,100%);animation:ac-rise .35s cubic-bezier(.2,.8,.2,1) both}
.ac-card img{display:block;width:100%;height:auto;aspect-ratio:1000/560;filter:drop-shadow(0 16px 30px rgba(0,0,0,.14))}
.ac-card.ac-locked img{filter:grayscale(1) contrast(.55) brightness(1.12)}
.ac-foot{display:flex;justify-content:space-between;align-items:center;gap:16px;width:min(860px,100%);padding:0 12px;box-sizing:border-box;font-size:13px;color:${color.textSecondary}}
.ac-foot>span{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ac-new{font-style:normal;padding:2px 8px;border-radius:999px;background:${color.greenSoft};color:${color.accentAction};font-size:11px;font-weight:500}
.ac-actions{display:flex;gap:8px;flex-shrink:0}
.ac-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;padding:0 16px;border-radius:999px;background:${color.surface};color:${color.text};box-shadow:inset 0 0 0 1px ${color.frame};font-size:13px;cursor:pointer;transition:opacity .2s}
.ac-btn:hover{opacity:.86}
.ac-btn:disabled{opacity:.35;cursor:default}
.ac-round{padding:0;font-size:16px}
.ac-btn.ac-close{position:absolute;top:16px;right:16px}
.ac-primary{background:${color.button};color:${color.buttonText};box-shadow:none}
@media (prefers-reduced-motion:reduce){.ac-overlay,.ac-overlay *,.ac-medal{animation:none!important;transition:none!important}}
`;

type Open = { view: "gallery"; filter: AchievementGroup | "all" } | { view: "card"; ids: string[]; index: number; back: AchievementGroup | "all" | null };

export function BadgeWall({ compact }: { compact: boolean }) {
  const state = useAchievements();
  const [open, setOpen] = useState<Open | null>(null);
  // 拖动中的顺序；松手才存
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragged = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 换位前每格的位置，渲染后让它们从原处滑过去
  const before = useRef<Map<string, DOMRect> | null>(null);
  const got = ACHIEVEMENTS.filter((item) => state.got[item.id]);
  // 每类只摆获得的最高一档
  const shelf = got.filter((item) => !got.some((other) => other.family === item.family && other.tier > item.tier));
  const byFamily = new Map(shelf.map((item) => [item.family, item]));
  const order = dragOrder ?? arrangeBadges([PIONEER, ...shelf.map((item) => item.family)], state.order);

  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    if (!from) return;
    for (const tile of listRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []) {
      const was = from.get(tile.dataset.key!);
      const now = tile.getBoundingClientRect();
      if (was && (was.left !== now.left || was.top !== now.top)) {
        tile.animate([{ transform: `translate(${was.left - now.left}px,${was.top - now.top}px)` }, { transform: "none" }], { duration: 180, easing: "cubic-bezier(.22,.61,.36,1)" });
      }
    }
  }, [dragOrder]);

  if (Platform.OS !== "web" || typeof document === "undefined") return null;

  const tileOf = (event: React.DragEvent) => (event.target as Element).closest<HTMLElement>("[data-key]");
  const onDragStart = (event: React.DragEvent) => {
    const key = tileOf(event)?.dataset.key;
    if (!key) return;
    dragged.current = key;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
    // 晚一拍再把原位变淡：同步改的话浏览器截的拖影也是淡的
    setTimeout(() => { if (dragged.current === key) setDragOrder((current) => current ?? order); });
  };
  // 拖到哪一格上就占它的位置，别的格子实时让开
  const onDragOver = (event: React.DragEvent) => {
    const from = dragged.current;
    if (!from) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = tileOf(event);
    const key = target?.dataset.key;
    // 正在滑的那格先别认：它从指针底下滑走的途中会被当成新目标，来回换个不停
    if (!key || key === from || target!.getAnimations().length) return;
    const next = order.filter((one) => one !== from);
    next.splice(order.indexOf(key), 0, from);
    before.current = new Map([...listRef.current!.querySelectorAll<HTMLElement>("[data-key]")].map((tile) => [tile.dataset.key!, tile.getBoundingClientRect()]));
    setDragOrder(next);
  };
  const onDragEnd = () => {
    if (dragged.current && dragOrder) setBadgeOrder(dragOrder);
    dragged.current = null;
    setDragOrder(null);
  };

  return (
    <div className="pb-slot" data-compact={compact || undefined}>
      <style>{css}</style>
      <div className="pb-tiles" onDragEnd={onDragEnd} onDragOver={onDragOver} onDragStart={onDragStart} onDrop={(event) => event.preventDefault()} ref={listRef}>
        {order.map((key) => {
          const item = byFamily.get(key);
          return (
            <div className="pb-tile" data-dragging={dragOrder && dragged.current === key ? "" : undefined} data-key={key} draggable={!compact} key={key}>
              {item ? (
                <button
                  aria-label={`${item.name}成就`}
                  className="ac-medal"
                  onClick={() => setOpen({ view: "card", ids: got.map((one) => one.id), index: got.indexOf(item), back: null })}
                  title={`${item.name} · ${item.condition}`}
                  type="button"
                >
                  <img alt="" draggable={false} src={item.medal} />
                  {state.seen.includes(item.id) ? null : <i className="ac-dot" />}
                </button>
              ) : <PioneerBadge />}
            </div>
          );
        })}
        <div className="pb-tile">
          <button aria-label={`全部成就，已获得 ${got.length} 枚`} className="ac-all" data-testid="achievements-all" onClick={() => setOpen({ view: "gallery", filter: "all" })} title="全部成就" type="button">
            {got.length}<small>/{ACHIEVEMENTS.length}</small>
          </button>
        </div>
      </div>
      {open ? createPortal(<Overlay open={open} setOpen={setOpen} state={state} />, document.body) : null}
    </div>
  );
}

function Overlay({ open, setOpen, state }: { open: Open; setOpen: (next: Open | null) => void; state: AchievementState }) {
  // 打开时哪些还没看过：这次看的时候一直挂着「新获得」，关了再开才消失
  const [seenBefore] = useState(state.seen);
  const card = open.view === "card" ? ACHIEVEMENTS[INDEX.get(open.ids[open.index]!)!]! : null;
  const step = (by: number) => { if (open.view === "card") setOpen({ ...open, index: (open.index + by + open.ids.length) % open.ids.length }); };

  useEffect(() => { if (card && state.got[card.id]) markAchievementSeen(card.id); }, [card, state.got]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
      else if (open.view === "card" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const total = ACHIEVEMENTS.filter((item) => state.got[item.id]).length;
  return (
    <div
      aria-label={card ? `${card.name}收藏卡` : "全部成就"}
      aria-modal
      className="ac-overlay"
      data-testid="achievements-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(null); }}
      role="dialog"
    >
      {open.view === "gallery" ? (
        <div className="ac-panel">
          <button aria-label="关闭" className="ac-btn ac-round ac-close" onClick={() => setOpen(null)} type="button">×</button>
          <div className="ac-head">
            <div>
              <div className="ac-eyebrow">DOUYIN DATA REVIEW · ACHIEVEMENTS</div>
              <h2>我的数字档案馆</h2>
              <p>把每一次积累，铸成值得收藏的记忆。</p>
            </div>
            <div className="ac-count">{total}<small>/ {ACHIEVEMENTS.length} 已获得</small></div>
          </div>
          <div className="ac-bar">
            {FILTERS.map(([key, label]) => (
              <button aria-pressed={open.filter === key} className="ac-pill" key={key} onClick={() => setOpen({ view: "gallery", filter: key })} type="button">
                {label}{key === "all" ? "" : ` · ${ACHIEVEMENTS.filter((item) => item.group === key).length}`}
              </button>
            ))}
          </div>
          <div className="ac-grid">
            {(() => {
              const list = ACHIEVEMENTS.filter((item) => open.filter === "all" || item.group === open.filter);
              return list.map((item, index) => {
                const owned = Boolean(state.got[item.id]);
                return (
                  <button className={owned ? "ac-tile" : "ac-tile ac-locked"} key={item.id} onClick={() => setOpen({ view: "card", ids: list.map((one) => one.id), index, back: open.filter })} type="button">
                    <img alt="" draggable={false} loading="lazy" src={item.medal} />
                    <b>{item.name}</b>
                    <span>{owned || item.group === "special" ? `${item.category} · ${TIER[item.tier]}` : `${fmt(progressOf(state, item))} / ${fmt(item.threshold)}`}</span>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      ) : card ? (
        <>
          <div className={state.got[card.id] ? "ac-card" : "ac-card ac-locked"} key={card.id}>
            <img alt={`${card.name}：${card.condition}`} draggable={false} src={card.card} />
          </div>
          <div className="ac-foot">
            <span>
              {serial(card.id)} · {card.category}
              {" · "}
              {state.got[card.id]
                ? `${state.got[card.id]} 获得`
                : card.group === "special" ? "还没获得" : `还没获得，进度 ${fmt(progressOf(state, card))} / ${fmt(card.threshold)}`}
              {state.got[card.id] && !seenBefore.includes(card.id) ? <i className="ac-new">新获得</i> : null}
            </span>
            <span className="ac-actions">
              <button aria-label="上一枚" className="ac-btn ac-round" disabled={open.ids.length < 2} onClick={() => step(-1)} type="button">←</button>
              <button aria-label="下一枚" className="ac-btn ac-round" disabled={open.ids.length < 2} onClick={() => step(1)} type="button">→</button>
              <button className="ac-btn ac-primary" onClick={() => setOpen({ view: "gallery", filter: open.view === "card" ? open.back ?? "all" : "all" })} type="button">全部成就</button>
              <button className="ac-btn" onClick={() => setOpen(null)} type="button">关闭</button>
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
