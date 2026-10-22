import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortcutText, type BoardAction } from "./aiEditKeymap";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// 看板的右键菜单（规格 1B）：挂到 body 上，不被轨道区的 overflow:hidden 裁掉；先藏着渲染量出真实大小再定位，
// 放不下就往反方向翻，两边都不够贴边留 8px；在外面按下、滚动、改窗口大小、窗口失焦都关；↑↓ Home End 回车能用；
// 点一项先关菜单再执行；不能用的项置灰、悬停写原因，不藏起来，每次菜单里的位置都一样。菜单项由调用方给。
// menuPosition / menuStep 和整体做法搬自 openfilm（studio/ui/src/lib/menu-position.ts、components/ContextMenu.tsx），
// MIT License，Copyright (c) 2026 OpenFilm contributors。

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** 删除这类：红字 */
  danger?: boolean;
  /** 不能用的原因：有就置灰、悬停写原因，位置照旧留着 */
  disabled?: string | false | null;
  /** 右边写的快捷键，按 BOARD_KEYS 的动作名读 */
  shortcut?: BoardAction;
  onSelect: () => void;
}
export interface MenuSeparator { id: string; separator: true }
export type MenuEntry = MenuItem | MenuSeparator;

const isItem = (entry: MenuEntry): entry is MenuItem => !("separator" in entry);

/** 菜单离窗口边至少这么远 */
export const MENU_EDGE = 8;

/** 菜单放在哪：默认往右下长，右边放不下往左翻；下面放不下、上面更宽敞时往上翻；最后都夹进窗口里。size 还没量出来时传 0。 */
export function menuPosition(at: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number } {
  const flippedX = size.width > 0 && at.x + size.width > viewport.width - MENU_EDGE;
  const flippedY = size.height > 0 && at.y + size.height > viewport.height - MENU_EDGE && at.y > viewport.height - at.y;
  return {
    left: Math.max(MENU_EDGE, Math.min(flippedX ? at.x - size.width : at.x, viewport.width - size.width - MENU_EDGE)),
    top: Math.max(MENU_EDGE, Math.min(flippedY ? at.y - size.height : at.y, viewport.height - size.height - MENU_EDGE)),
  };
}

/** 方向键落在第几项：from < 0 是还没用过键盘，↓ 落第一项、↑ 落最后一项；到头了绕回去。 */
export function menuStep(from: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (from < 0) return delta > 0 ? 0 : count - 1;
  return (from + delta + count) % count;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: readonly MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 键盘停在可用项里的第几个；-1 是还没用过键盘，这时不高亮任何一项
  const [active, setActive] = useState(-1);
  const usable = useMemo(() => items.filter((entry): entry is MenuItem => isItem(entry) && !entry.disabled), [items]);

  // 量完再定位，在浏览器画出来之前定好，不会在错的位置闪一下；焦点拉进来，方向键管菜单不管下面的看板
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    setPos(menuPosition({ x, y }, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
    node.focus({ preventScroll: true });
  }, [x, y, items]);

  useEffect(() => {
    const close = (event: Event) => {
      // 菜单自己里面按下、自己滚动不算；别处滚动就关：菜单钉在屏幕坐标上，下面的东西滚走了它就指错了
      if ((event.type === "pointerdown" || event.type === "scroll") && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    // Esc 是菜单的：在捕获阶段拿走并拦住，下面的看板、详情卡不会跟着收
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [onClose]);

  const run = (item: MenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!usable.length) return;
    const go = (index: number) => { event.preventDefault(); setActive(index); };
    if (event.key === "ArrowDown") go(menuStep(active, 1, usable.length));
    else if (event.key === "ArrowUp") go(menuStep(active, -1, usable.length));
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(usable.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      const item = usable[active];
      if (item) { event.preventDefault(); run(item); }
    }
  };

  if (typeof document === "undefined") return null;
  const activeId = active >= 0 && usable[active] ? `board-menu-${usable[active]!.id}` : undefined;
  return createPortal(<div
    ref={ref}
    role="menu"
    tabIndex={-1}
    aria-orientation="vertical"
    aria-activedescendant={activeId}
    onKeyDown={onKeyDown}
    onContextMenu={(event) => event.preventDefault()}
    style={{
      position: "fixed", left: pos?.left ?? x, top: pos?.top ?? y, zIndex: 10_060, minWidth: 196, maxHeight: `calc(100vh - ${2 * MENU_EDGE}px)`,
      overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", padding: "4px 0", outline: "none",
      // 量出大小之前藏着：第一帧画在没调过的位置上会看到它闪出屏幕
      visibility: pos ? "visible" : "hidden",
      backgroundColor: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.medium, fontFamily: font.body,
    }}
  >
    {items.map((entry) => {
      if (!isItem(entry)) return <div key={entry.id} role="separator" style={{ height: 1, margin: "4px 0", backgroundColor: color.borderSoft }} />;
      const index = usable.indexOf(entry);
      const on = index >= 0 && index === active;
      return <button
        key={entry.id}
        id={`board-menu-${entry.id}`}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={entry.disabled ? true : undefined}
        title={entry.disabled || undefined}
        // 鼠标移到哪一项，键盘位置也跟过去：两边对不上时回车会执行另一项
        onPointerEnter={() => setActive(index)}
        onPointerLeave={() => setActive((current) => (current === index ? -1 : current))}
        onClick={() => run(entry)}
        style={{
          display: "flex", alignItems: "center", gap: 9, width: "100%", boxSizing: "border-box", padding: "6px 12px", border: "none", textAlign: "left",
          backgroundColor: on ? color.surfaceMuted : "transparent", cursor: entry.disabled ? "default" : "pointer", fontFamily: font.body, fontSize: 12.5, lineHeight: "18px",
          color: entry.disabled ? color.textMuted : entry.danger ? color.danger : color.text, opacity: entry.disabled ? 0.6 : 1,
        }}
      >
        {entry.icon ? <span aria-hidden style={{ display: "flex", width: 14, flexShrink: 0, justifyContent: "center" }}>{entry.icon}</span> : null}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
        {entry.shortcut ? <span style={{ flexShrink: 0, color: color.textMuted, fontSize: 11 }}>{shortcutText(entry.shortcut)}</span> : null}
      </button>;
    })}
  </div>, document.body);
}

/**
 * 右键菜单的状态：onContextMenu 里 preventDefault 后调 open(事件坐标, 菜单项)，把 element 渲染在组件里任意位置（会挂到 body）。
 * 菜单开着时 Esc 只关菜单。
 */
export function useContextMenu(): { open: (at: { x: number; y: number }, items: readonly MenuEntry[]) => void; close: () => void; isOpen: boolean; element: React.ReactNode } {
  const [menu, setMenu] = useState<{ x: number; y: number; items: readonly MenuEntry[] } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback((at: { x: number; y: number }, items: readonly MenuEntry[]) => setMenu({ x: at.x, y: at.y, items }), []);
  const element = menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} /> : null;
  return { open, close, isOpen: Boolean(menu), element };
}
