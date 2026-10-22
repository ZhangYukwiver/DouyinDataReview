import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, StyleSheet, View } from "react-native";
import { History, Redo2, Sparkles, Undo2 } from "lucide-react-native";
import type { AiEditStepKind } from "../../services/aiEdit";
import { useBoard, useEscapeLayer } from "./aiEditBoardContext";
import { undoKind } from "./aiEditBoardEdit";
import { HISTORY_WIDTH, historyConfirmText, historyPanelPosition, historyStepText, lastingReason } from "./aiEditInspect";
import { shortcutText } from "./aiEditKeymap";
import { menuStep } from "./AiEditMenu";
import { pressableDisabled, shortTime, web, WebTitle, webPointer } from "./aiEditShared";
import { ws } from "./motion";
import { alpha, workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// 看板标题行里的撤销、重做和操作历史。按钮什么都能撤，AI 剪的一整轮也能；键盘 ⌘Z 不撤 AI 那一轮的拦法在 AiEditBoard 里（C9）。
// 操作历史（D10）照 openfilm 的 OperationHistory（studio/ui/src/components/OperationHistory.tsx，MIT License，
// Copyright (c) 2026 OpenFilm contributors）：挂在撤销旁边，最新的在上，下一下 ⌘Z 会撤的那行挂小标，点一行撤到那一步之前。

export const HistoryControls = memo(function HistoryControls() {
  const { session, editable, notEditableReason, undo, redo } = useBoard();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  const last = session?.undo ?? null;
  // 存档的说法是「撤到哪」（AI 那一轮是「AI 处理“…”之前」），按钮上要说「撤掉、重做的是什么」
  const undoText = last ? historyStepText(last) : null;
  const redoLabel = session?.redo?.label ?? null;
  const redoText = redoLabel ? historyStepText({ label: redoLabel }) : null;
  const lasting = editable ? null : lastingReason(notEditableReason);
  const undoBlocked = !last ? "没有能撤销的改动" : lasting;
  const redoBlocked = !redoLabel ? "没有能重做的改动" : lasting;
  const undoTitle = !last ? ""
    : undoKind(last) === "turn" ? `撤销：${undoText}（AI 剪的一整轮要点这里撤，${shortcutText("undo")} 不会撤它）`
      : `撤销：${undoText}（${shortcutText("undo")}）`;
  const close = useCallback(() => setOpen(false), []);
  return <View style={styles.group}>
    <IconButton label={undoText ? `撤销：${undoText}` : "撤销"} title={undoTitle} blocked={undoBlocked} onPress={() => void undo()}>
      <Undo2 size={16} color={color.text} />
    </IconButton>
    <IconButton label={redoText ? `重做：${redoText}` : "重做"} title={redoText ? `重做：${redoText}（${shortcutText("redo")}）` : ""} blocked={redoBlocked} onPress={() => void redo()}>
      <Redo2 size={16} color={color.text} />
    </IconButton>
    {web ? <View ref={anchorRef} collapsable={false}>
      <IconButton label="操作历史" title={open ? "收起操作历史" : "操作历史：最近做过的改动，点一行撤到那一步之前"} expanded={open} onPress={() => setOpen((value) => !value)}>
        <History size={16} color={color.text} />
      </IconButton>
    </View> : null}
    {open ? <HistoryPanel anchor={anchorRef} onClose={close} /> : null}
  </View>;
});

/** 标题行的小方按钮：不能用时 aria-disabled、悬停写原因（不写 disabled）；鼠标按下不抢焦点 */
function IconButton({ label, title, blocked = null, expanded, onPress, children }: {
  label: string; title: string; blocked?: string | null; expanded?: boolean; onPress: () => void; children: React.ReactNode;
}) {
  return <WebTitle title={blocked ?? title} keepFocus>
    <Pressable
      {...ws("btn square")}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(expanded === undefined ? null : { "aria-expanded": expanded })}
      {...pressableDisabled(blocked)}
      onPress={() => { if (!blocked) onPress(); }}
      style={[styles.iconButton, blocked ? styles.disabled : webPointer, expanded && styles.iconButtonOn]}
    >
      {children}
    </Pressable>
  </WebTitle>;
}

/** 今天的只写钟点，别的日子只写几月几日（面板窄，写不下两样） */
function stepTime(at: string): string {
  const text = shortTime(at);
  return text.startsWith("今天 ") ? text.slice(3) : text.replace(/ \d{2}:\d{2}$/u, "");
}

/**
 * 操作历史面板：挂到 body 上，在按钮下面、右边对齐。最上面是能重做的那一步（淡、划掉），下面是存档，新的在前。
 * 点最新那行直接撤；点更早的先在面板底下确认会连着撤几步。按在外面、改窗口大小、Esc 都会关；↑↓ Home End 在行间走。
 * 用 role=menu：焦点在里面时看板的快捷键不响应，点里面的行也不算按到看板外面。
 */
function HistoryPanel({ anchor, onClose }: { anchor: React.RefObject<View | null>; onClose: () => void }) {
  const { session, editable, notEditableReason, undo, redo, toast } = useBoard();
  const ref = useRef<HTMLDivElement | null>(null);
  const inside = useRef(false);
  const [pos, setPos] = useState<ReturnType<typeof historyPanelPosition> | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const steps = session?.history ?? [];
  const redoLabel = session?.redo?.label ?? null;
  const blocked = editable ? null : lastingReason(notEditableReason);
  const confirmIndex = confirming ? steps.findIndex((step) => step.id === confirming) : -1;
  const trigger = () => anchor.current as unknown as HTMLElement | null;

  // 量按钮位置再定位，画出来之前定好；焦点拉进来，↑↓ 管面板不管下面的看板；关掉时焦点还在面板里就还回去
  useLayoutEffect(() => {
    const rect = trigger()?.getBoundingClientRect();
    if (rect) setPos(historyPanelPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => { if (inside.current) before?.focus?.({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    // 按钮自己不算外面：不然按下关掉、松手又打开，用按钮永远关不上
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || trigger()?.contains(target))) return;
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Esc：在确认就只退出确认，否则关面板
  useEscapeLayer(() => {
    if (confirming) setConfirming(null);
    else onClose();
    return true;
  }, true);

  useEffect(() => {
    if (confirmIndex >= 0) ref.current?.querySelector<HTMLButtonElement>("[data-history-confirm]")?.focus({ preventScroll: true });
    // 确认到一半那一步没了（AI 又剪了一轮、别处撤销了）：不再确认
    else if (confirming) setConfirming(null);
  }, [confirmIndex, confirming]);

  const pick = (index: number) => {
    if (blocked) { toast(blocked); return; }
    const step = steps[index];
    if (!step) return;
    if (index > 0) { setConfirming(step.id); return; }
    onClose();
    void undo(step.id);
  };
  const confirm = () => {
    const step = steps[confirmIndex];
    if (!step) return;
    if (blocked) { toast(blocked); return; }
    onClose();
    void undo(step.id);
  };
  const redoNow = () => {
    if (blocked) { toast(blocked); return; }
    onClose();
    void redo();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-history-row], [data-history-confirm], [data-history-cancel]") ?? [])];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => { event.preventDefault(); rows[index]?.focus({ preventScroll: true }); };
    if (event.key === "ArrowDown") go(menuStep(at, 1, rows.length));
    else if (event.key === "ArrowUp") go(menuStep(at, -1, rows.length));
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(rows.length - 1);
  };

  if (typeof document === "undefined") return null;
  return createPortal(<div
    ref={ref}
    role="menu"
    aria-label="操作历史"
    tabIndex={-1}
    onKeyDown={onKeyDown}
    onFocus={() => { inside.current = true; }}
    onBlur={(event) => { if (!ref.current?.contains(event.relatedTarget as Node | null)) inside.current = false; }}
    onContextMenu={(event) => event.preventDefault()}
    style={{
      position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, width: HISTORY_WIDTH, maxHeight: pos?.maxHeight ?? 440, zIndex: 10_050,
      // 量出位置之前藏着，免得在左上角闪一下
      visibility: pos ? "visible" : "hidden",
      display: "flex", flexDirection: "column", overflow: "hidden", boxSizing: "border-box", outline: "none",
      backgroundColor: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.medium, fontFamily: font.body,
    }}
  >
    <div style={panel.head}>
      <span style={panel.title}>操作历史</span>
      <span style={panel.small}>最多记 50 步</span>
    </div>
    {blocked ? <div style={panel.note}>{blocked}，现在点了也撤不了。</div> : null}
    <div style={panel.list}>
      {redoLabel ? <HistoryRow
        undone
        text={historyStepText({ label: redoLabel })}
        kind={undoKind({ label: redoLabel })}
        badge={shortcutText("redo")}
        title={blocked ?? `刚撤销掉的，点一下重做回来（${shortcutText("redo")}）`}
        disabled={Boolean(blocked)}
        onPick={redoNow}
      /> : null}
      {steps.length ? steps.map((step, index) => <HistoryRow
        key={step.id}
        text={historyStepText(step)}
        kind={step.kind}
        at={stepTime(step.at)}
        // 下一下 ⌘Z 会撤的那行；AI 剪的一整轮 ⌘Z 不撤，不挂
        badge={index === 0 && step.kind !== "turn" ? shortcutText("undo") : null}
        marked={confirmIndex >= 0 && index <= confirmIndex}
        title={blocked ?? (index === 0 ? "撤销这一步" : `撤到这一步之前，会连着撤 ${index + 1} 步`)}
        disabled={Boolean(blocked)}
        onPick={() => pick(index)}
      />) : <p style={panel.empty}>还没有改动。AI 剪一轮、在看板上手动改、退回到某句话之前，都会记在这里。</p>}
    </div>
    {confirmIndex >= 0 ? <div style={panel.confirm}>
      <p style={panel.confirmText}>{historyConfirmText(steps, confirmIndex)}</p>
      <div style={panel.confirmRow}>
        <button type="button" role="menuitem" data-history-confirm onClick={confirm} style={{ ...panel.button, ...panel.primary }}>撤销这 {confirmIndex + 1} 步</button>
        <button type="button" role="menuitem" data-history-cancel onClick={() => setConfirming(null)} style={panel.button}>算了</button>
      </div>
    </div> : null}
  </div>, document.body);
}

function HistoryRow({ text, kind, at, badge, undone = false, marked = false, title, disabled, onPick }: {
  text: string; kind: AiEditStepKind | null; at?: string; badge?: string | null; undone?: boolean; marked?: boolean; title: string; disabled: boolean; onPick: () => void;
}) {
  // 鼠标移上去、键盘停在上面都亮一下
  const [lit, setLit] = useState(false);
  return <button
    type="button"
    role="menuitem"
    data-history-row
    title={title}
    aria-disabled={disabled || undefined}
    onClick={onPick}
    onPointerEnter={() => setLit(true)}
    onPointerLeave={() => setLit(false)}
    onFocus={() => setLit(true)}
    onBlur={() => setLit(false)}
    style={{
      display: "flex", alignItems: "center", gap: 6, width: "100%", boxSizing: "border-box", padding: "5px 8px", border: "none", borderRadius: radius.small, textAlign: "left",
      backgroundColor: marked ? alpha(color.danger, 0.12) : lit ? color.surfaceMuted : "transparent", cursor: disabled ? "default" : "pointer", outline: "none",
      fontFamily: font.body, fontSize: 12, lineHeight: "18px", color: undone ? color.textMuted : color.text, opacity: disabled ? 0.6 : 1,
    }}
  >
    <span style={panel.icon}>
      {kind === "turn" ? <Sparkles size={11} color={color.accent} /> : kind === "revert" ? <Undo2 size={11} color={color.textMuted} /> : <span style={panel.dot} />}
    </span>
    <span style={{ ...panel.text, ...(undone ? { textDecorationLine: "line-through" } : null) }}>{text}</span>
    {badge ? <span style={panel.badge}>{badge}</span> : null}
    {at ? <span style={panel.at}>{at}</span> : null}
  </button>;
}

const panel: Record<string, React.CSSProperties> = {
  head: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexShrink: 0, padding: "8px 12px", borderBottom: `1px solid ${color.borderSoft}` },
  title: { color: color.text, fontSize: 12, fontWeight: 600 },
  small: { color: color.textMuted, fontSize: 10.5 },
  note: { flexShrink: 0, padding: "6px 12px 0", color: color.textMuted, fontSize: 11, lineHeight: "16px" },
  list: { flex: 1, minHeight: 0, overflowY: "auto", padding: 4 },
  empty: { margin: 0, padding: "8px", color: color.textMuted, fontSize: 12, lineHeight: "19px" },
  icon: { width: 12, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  dot: { width: 5, height: 5, borderRadius: 999, backgroundColor: color.textMuted },
  text: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: { flexShrink: 0, padding: "0 6px", borderRadius: 999, backgroundColor: alpha(color.accent, 0.15), color: color.accent, fontSize: 10, fontWeight: 600, lineHeight: "16px" },
  at: { flexShrink: 0, color: color.textMuted, fontSize: 10.5, fontVariantNumeric: "tabular-nums" },
  confirm: { flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderTop: `1px solid ${color.borderSoft}` },
  confirmText: { margin: 0, color: color.text, fontSize: 11.5, lineHeight: "18px" },
  confirmRow: { display: "flex", gap: 8 },
  button: {
    height: 26, padding: "0 10px", borderRadius: radius.small, border: `1px solid ${color.border}`, backgroundColor: color.surface, color: color.text,
    fontFamily: font.body, fontSize: 11.5, cursor: "pointer",
  },
  primary: { borderColor: color.button, backgroundColor: color.button, color: color.buttonText, fontWeight: 600 },
};

const styles = StyleSheet.create({
  group: { flexDirection: "row", alignItems: "center", gap: 4 },
  iconButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  iconButtonOn: { borderColor: color.accent, backgroundColor: color.accentSoft },
  disabled: { opacity: 0.45 },
});
