import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Scissors, Trash2, X } from "lucide-react-native";
import type { EditProject, EditSegment } from "../../services/aiEdit";
import { clipDetail, findSegment, mediaIdFromPath } from "./aiEditModel";
import { useBoard } from "./aiEditBoardContext";
import {
  applyFieldInput, coveredRows, fieldEditNow, formatField, inspectFields, lastingReason, parseFieldInput, SCRUB_SLOP_PX, scrubValue, selectionSummary, settleField, strideOf, type InspectField,
} from "./aiEditInspect";
import { comboText, composing, IS_MAC, shortcutText, textBoxKey } from "./aiEditKeymap";
import { ariaDisabledProps, clipTone, mediaTitle, pressableDisabled, web, WebTitle, webAutoHeight, webPointer } from "./aiEditShared";
import { kit, SmallButton } from "./CreatorKit";
import { ws } from "./motion";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// 选中片段时画面右边的详情卡：顶上能切开、删除；开始、时长、素材起点、倍速、位置、缩放、旋转、不透明度是能拖、能输的数值框；
// 文字片段能直接改文字。选了好几段时只说选了什么、给删除。

/**
 * 详情卡；没选片段时不画。width 由看板按画面那一行的宽度给；
 * projectNow 取看板手里最新的工程（请求一回来就换，不等重渲染），数值框 flush 完微调以后按它算。
 */
export const ClipCard = memo(function ClipCard({ width, projectNow }: { width: number; projectNow: () => EditProject | null }) {
  const { selected, selection } = useBoard();
  if (!selected) return null;
  // key 取片段 id：换了片段就从卡片顶上看起，同一片段被 AI 改了内容时滚动位置不动
  return <View {...ws("e-box", "ai-panel", "sticky")} accessibilityLabel="片段详情" style={[styles.detail, { width }]}>
    {selection.ids.length > 1 ? <ManyBody count={selection.ids.length} /> : <ClipBody key={selected.segment.id} projectNow={projectNow} />}
  </View>;
});

function ClipBody({ projectNow }: { projectNow: () => EditProject | null }) {
  const { selected, mediaById, canvas, project, notEditableReason, splitHint, split, removeSelected, runEdit, flushHeld, toast, selection } = useBoard();
  const item = useMemo(() => {
    const segment = selected?.segment;
    return segment && "path" in segment ? mediaById.get(mediaIdFromPath(segment.path) ?? "") : undefined;
  }, [selected, mediaById]);
  const info = useMemo(() => (selected ? clipDetail(selected.segment, { mediaName: item ? mediaTitle(item) : null, track: selected.track }) : null), [selected, item]);
  const fields = useMemo(() => {
    if (!web || !selected) return [];
    const { segment, track } = selected;
    return inspectFields(segment, { canvas, siblings: track.segments.filter((other) => other.id !== segment.id), mediaDurationUs: item?.durationUs });
  }, [selected, canvas, item]);
  if (!selected || !info) return null;
  const { segment } = selected;
  const lasting = lastingReason(notEditableReason);
  const splitBlocked = lasting ?? splitHint;
  const covered = coveredRows(fields);
  // 数值框提交：先把别处攒着的微调发出去，再按回来的工程算这一下（一步撤销）——位置、缩放这几项发的是整个 transform，
  // 按 flush 之前的样子算会把刚挪的位置写回去。值没变返回 false，框里就回到原来的值
  const commitField = async (field: InspectField, value: number) => {
    await flushHeld();
    const edit = fieldEditNow(projectNow(), segment.id, field.key, value, canvas);
    if (!edit) return false;
    return runEdit(edit.name, edit.arguments);
  };
  const saveText = async (text: string) => {
    await flushHeld();
    return runEdit("update_clip", { clip_id: segment.id, text });
  };
  return <>
    <View style={styles.detailHead}>
      <View style={[styles.detailDot, { backgroundColor: clipTone(segment) }]} />
      <Text numberOfLines={1} style={styles.detailKind}>{info.kind}片段</Text>
      <CardAction label="切开" title={splitBlocked ?? `在播放头处切开（${shortcutText("split")}）`} blocked={splitBlocked} onPress={() => void split(segment.id)}>
        <Scissors size={12} color={color.text} />
      </CardAction>
      <CardAction label="删除" title={lasting ?? `删除（${shortcutText("remove")}）`} blocked={lasting} danger onPress={() => void removeSelected()}>
        <Trash2 size={12} color={color.danger} />
      </CardAction>
      <CloseButton onPress={selection.clear} />
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.detailBody}>
      {segment.kind === "text"
        ? <TextEditor text={segment.text} editable={!lasting} onSave={saveText} />
        : <Text selectable style={styles.detailTitle}>{info.title}</Text>}
      {fields.length ? <FieldList fields={fields} version={project?.revision ?? 0} blocked={lasting} onCommit={commitField} onRefuse={(text) => toast(text)} /> : null}
      {info.rows.filter((row) => !covered.has(row.label)).map((row, index) => <View key={index} style={styles.detailRow}>
        <Text style={styles.detailLabel}>{row.label}</Text>
        <View style={styles.detailValueBox}>
          {row.swatch ? <View style={[styles.swatch, { backgroundColor: row.swatch }]} /> : null}
          <Text selectable style={styles.detailValue}>{row.value}</Text>
        </View>
      </View>)}
    </ScrollView>
  </>;
}

/** 选了好几段：说选了什么，给删除 */
function ManyBody({ count }: { count: number }) {
  const { project, notEditableReason, removeSelected, selection } = useBoard();
  const lasting = lastingReason(notEditableReason);
  const summary = useMemo(() => selectionSummary(selection.ids.map((id) => findSegment(project, id)?.segment).filter((segment): segment is EditSegment => Boolean(segment))),
    [project, selection.ids]);
  return <>
    <View style={styles.detailHead}>
      <Text numberOfLines={1} style={styles.detailKind}>选了 {count} 段</Text>
      <CardAction label="删除" title={lasting ?? `把这 ${count} 段都删掉（${shortcutText("remove")}）`} blocked={lasting} danger onPress={() => void removeSelected()}>
        <Trash2 size={12} color={color.danger} />
      </CardAction>
      <CloseButton onPress={selection.clear} />
    </View>
    <View style={styles.detailBody}>
      <Text style={kit.muted}>{summary ? `${summary}。` : ""}删除会一起删掉，撤销一次就都回来。想改某一段的时间、位置这些数值，在轨道上单独点它。</Text>
    </View>
  </>;
}

/** 卡片顶上的小按钮：不能用时 aria-disabled、悬停写原因（不写 disabled）；鼠标按下不抢焦点 */
function CardAction({ label, title, blocked, danger = false, onPress, children }: {
  label: string; title: string; blocked: string | null; danger?: boolean; onPress: () => void; children: React.ReactNode;
}) {
  return <WebTitle title={title} keepFocus>
    <Pressable accessibilityRole="button" accessibilityLabel={blocked ? `${label}：${blocked}` : title} {...pressableDisabled(blocked)} onPress={() => { if (!blocked) onPress(); }}
      style={[styles.detailAction, blocked ? styles.disabled : webPointer]}>
      {children}<Text style={[styles.detailActionText, danger && { color: color.danger }]}>{label}</Text>
    </Pressable>
  </WebTitle>;
}

function CloseButton({ onPress }: { onPress: () => void }) {
  return <WebTitle title="收起（Esc）" keepFocus>
    <Pressable accessibilityRole="button" accessibilityLabel="收起片段详情" hitSlop={8} onPress={onPress} style={[styles.detailClose, webPointer]}>
      <X size={14} color={color.textMuted} />
    </Pressable>
  </WebTitle>;
}

/**
 * 文字片段的内容直接在详情卡里改；AI 或撤销改了这段文字、自己又没动过时跟着换。
 * ⌘↵ 保存（输入法选字时不算），焦点在框里按 Esc：字还原、框失焦，卡片不收（E3、C4）。内容没变或是空的不发。
 * 这两个键都在框自己的 onKeyPress 里接：RN-web 的 TextInput 不让按键冒泡，看板的 Esc 分层收不到。
 */
function TextEditor({ text, editable, onSave }: { text: string; editable: boolean; onSave: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(text);
  const [base, setBase] = useState(text);
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  if (base !== text) {
    setBase(text);
    if (draft === base) setDraft(text);
  }
  const changed = draft !== text;
  const canSave = editable && !saving && changed && Boolean(draft.trim());
  const save = async () => {
    setSaving(true);
    await onSave(draft);
    setSaving(false);
  };
  return <View style={styles.textEdit}>
    <TextInput
      ref={inputRef}
      accessibilityLabel="文字内容"
      multiline
      maxLength={2000}
      value={draft}
      editable={!saving}
      onChangeText={setDraft}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyPress={(event) => {
        const action = web ? textBoxKey(event.nativeEvent as unknown as KeyboardEvent) : null;
        if (!action) return;
        event.preventDefault();
        if (action === "revert") {
          setDraft(text);
          inputRef.current?.blur();
        } else if (canSave) void save();
      }}
      placeholder="写上要显示的文字"
      placeholderTextColor={color.textMuted}
      style={[styles.fieldInput, styles.textEditInput, webAutoHeight]}
    />
    <View style={kit.row}>
      <SmallButton label={saving ? "保存中…" : "保存"} disabled={!canSave} onPress={() => void save()} />
      {changed && !saving ? <SmallButton label="还原" onPress={() => setDraft(text)} /> : null}
      {web && (focused || changed) ? <Text style={styles.keyHint}>{comboText("mod+Enter")} 保存，Esc 还原</Text> : null}
    </View>
  </View>;
}

// ---------- 能拖、能输的数值框（规格 1B） ----------

type CommitField = (field: InspectField, value: number) => Promise<boolean>;
const SHIFT = IS_MAC ? "⇧" : "Shift";
const ALT = IS_MAC ? "⌥" : "Alt";
const TIME_KEYS = new Set(["start", "duration", "source_start", "speed"]);

function FieldList({ fields, version, blocked, onCommit, onRefuse }: {
  fields: readonly InspectField[]; version: number; blocked: string | null; onCommit: CommitField; onRefuse: (text: string) => void;
}) {
  const common = { version, blocked, onCommit, onRefuse };
  // 位置的 X、Y 并成一行；时间几项和画面几项之间空开一点
  const rows: InspectField[][] = [];
  for (const field of fields) {
    const last = rows.at(-1);
    if (field.key === "y" && last?.[0]?.key === "x") last.push(field);
    else rows.push([field]);
  }
  return <div style={fieldStyles.list}>
    {rows.map((row, index) => {
      const gap = index > 0 && TIME_KEYS.has(rows[index - 1]![0]!.key) && !TIME_KEYS.has(row[0]!.key);
      return <div key={row[0]!.key} style={{ ...fieldStyles.row, ...(gap ? { marginTop: 6 } : null) }}>
        {row.length > 1
          ? <><span style={fieldStyles.label}>{row[0]!.label}</span>{row.map((field) => <MarkedField key={field.key} field={field} {...common} />)}</>
          : <LabeledField field={row[0]!} {...common} />}
      </div>;
    })}
  </div>;
}

interface FieldProps { field: InspectField; version: number; blocked: string | null; onCommit: CommitField; onRefuse: (text: string) => void }

/** 一行一个框：行首的字就是拖动把手 */
function LabeledField(props: FieldProps) {
  const box = useNumberField(props);
  return <>
    <span {...box.handle} style={{ ...fieldStyles.label, ...(box.reason ? null : fieldStyles.grip) }}>{props.field.label}</span>
    <FieldBox box={box} field={props.field} />
  </>;
}

/** 位置那一行的两个框：把手是框里的 X、Y */
function MarkedField(props: FieldProps) {
  const box = useNumberField(props);
  return <FieldBox box={box} field={props.field} mark={<span {...box.handle} style={{ ...fieldStyles.mark, ...(box.reason ? null : fieldStyles.grip) }}>{props.field.mark}</span>} />;
}

function FieldBox({ box, field, mark }: { box: NumberField; field: InspectField; mark?: React.ReactNode }) {
  const active = box.focused || box.dragging;
  // 点在框的空白边上（单位、内边距）也算点进框里
  const focusInput = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === box.input.ref.current) return;
    event.preventDefault();
    box.focus();
  };
  return <div onMouseDown={focusInput} style={{ ...fieldStyles.box, borderColor: active ? color.accent : color.border, opacity: box.reason ? 0.55 : 1 }}>
    {mark}
    <input {...box.input} style={{ ...fieldStyles.input, ...(field.animated && box.text === null ? fieldStyles.animated : null) }} />
    {field.unit && !field.animated ? <span style={fieldStyles.unit}>{field.unit}</span> : null}
  </div>;
}

type NumberField = ReturnType<typeof useNumberField>;

/**
 * 一个数值框：打字、拖把手、按 ↑↓ 时只改框里的字，回车、Tab、失焦、松手才提交一次（一个手势一步撤销）；Esc 还原。
 * 拖把手：横着每 6 像素一步，⇧ 大十倍、⌥ 细十倍，挪不到 2 像素算点一下，点进框里全选。
 * 提交了还没回来时先显示提交的值，新工程进来（或失败）再换回工程里的值，不会闪回原来的数。
 */
function useNumberField({ field, version, blocked, onCommit, onRefuse }: FieldProps) {
  const reason = blocked ?? field.disabled;
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stamp = `${version}:${field.value}`;
  const [seen, setSeen] = useState(stamp);
  if (seen !== stamp) {
    setSeen(stamp);
    if (pending !== null) setPending(null);
  }
  const current = pending ?? field.value;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelled = useRef(false);
  // 点进框里时全选：焦点是按下鼠标时进来的，紧跟着的松开会把全选改成光标，拦掉这一下
  const keepSelection = useRef(false);
  const drag = useRef<{ x: number; start: number; moved: boolean; value: number } | null>(null);
  const sent = useRef(0);
  const latest = useRef({ field, current, text, reason, onCommit, onRefuse });
  latest.current = { field, current, text, reason, onCommit, onRefuse };

  /** 打进去的字作用在现在的值上；读不懂为 null */
  const read = (raw: string): number | null => {
    const input = parseFieldInput(raw, latest.current.field.ctx);
    return input ? applyFieldInput(input, latest.current.current) : null;
  };
  const send = (value: number) => {
    const { field: now, current: was, onCommit: commit } = latest.current;
    if (Math.abs(value - was) < 1e-9) return;
    const ticket = ++sent.current;
    setPending(value);
    void commit(now, value).then((ok) => { if (!ok && sent.current === ticket) setPending(null); });
  };
  const commitText = () => {
    const { text: typed, field: now, current: was } = latest.current;
    setText(null);
    if (typed === null || !typed.trim() || typed.trim() === formatField(now, was)) return;
    const raw = read(typed);
    if (raw === null) {
      latest.current.onRefuse(`没看懂“${typed.trim()}”，${now.time ? "可以写 1.5、500ms、12f 这样" : "写个数字试试"}`);
      return;
    }
    const settled = settleField(now, raw, true);
    if ("refused" in settled) latest.current.onRefuse(settled.refused);
    else send(settled.value);
  };
  /** 不是点在框里进来的（点把手、点框边）：聚焦并全选，后面不会再有松开来改掉全选 */
  const focus = () => {
    inputRef.current?.focus();
    inputRef.current?.select();
    keepSelection.current = false;
  };
  const cancelDrag = () => {
    drag.current = null;
    setDragging(false);
    setText(null);
  };

  // 拖动中：整页光标换成左右箭头、不选中文字；按 Esc 取消这次拖动（先于看板拿走，卡片不收）
  useEffect(() => {
    if (!dragging) return undefined;
    const body = document.body.style;
    const before = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = "ew-resize";
    body.userSelect = "none";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      body.cursor = before.cursor;
      body.userSelect = before.userSelect;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [dragging]);
  // 拖到一半变得不能改了（AI 开始剪了）：直接放弃
  useEffect(() => { if (reason && drag.current) cancelDrag(); }, [reason]);

  const input: React.InputHTMLAttributes<HTMLInputElement> & { ref: React.RefObject<HTMLInputElement | null> } = {
    ref: inputRef,
    type: "text",
    inputMode: "decimal",
    spellCheck: false,
    autoComplete: "off",
    readOnly: Boolean(reason),
    value: text ?? (field.animated ? "关键帧" : formatField(field, current)),
    "aria-label": field.name,
    ...ariaDisabledProps(reason),
    title: reason ?? `${field.name}：${field.hint}。↑↓ 一次走一步，回车确认，Esc 还原`,
    onFocus: (event) => {
      setFocused(true);
      if (latest.current.reason) return;
      cancelled.current = false;
      keepSelection.current = true;
      setText(formatField(latest.current.field, latest.current.current));
      event.currentTarget.select();
    },
    onMouseUp: (event) => {
      if (!keepSelection.current) return;
      keepSelection.current = false;
      event.preventDefault();
    },
    onChange: (event) => { if (!latest.current.reason) setText(event.currentTarget.value); },
    onBlur: () => {
      setFocused(false);
      keepSelection.current = false;
      if (cancelled.current) { cancelled.current = false; setText(null); return; }
      commitText();
    },
    onKeyDown: (event) => {
      keepSelection.current = false;
      if (composing(event.nativeEvent)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        // 拦住看板的 Esc：只还原这个框，卡片不收（C4）
        event.preventDefault();
        cancelled.current = true;
        setText(null);
        event.currentTarget.blur();
      } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !latest.current.reason) {
        event.preventDefault();
        const { field: now, text: typed, current: was } = latest.current;
        const base = (typed !== null ? read(typed) : null) ?? was;
        const stride = strideOf(now.step, { shift: event.shiftKey, alt: event.altKey });
        const next = settleField(now, base + (event.key === "ArrowUp" ? stride : -stride));
        if ("value" in next) setText(formatField(now, next.value));
      }
    },
  };

  const handle: React.HTMLAttributes<HTMLSpanElement> = reason ? { title: reason, "aria-hidden": true } : {
    "aria-hidden": true,
    title: `${field.name}：左右拖动调整，按住 ${SHIFT} 一次走十步、按住 ${ALT} 走得更细；点一下直接输入`,
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      // 不让按下去选中文字、也不让焦点跳走
      event.preventDefault();
      const { text: typed, current: was } = latest.current;
      drag.current = { x: event.clientX, start: (typed !== null ? read(typed) : null) ?? was, moved: false, value: was };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event) => {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.x;
      if (!state.moved && Math.abs(dx) < SCRUB_SLOP_PX) return;
      if (!state.moved) { state.moved = true; setDragging(true); }
      const now = latest.current.field;
      const settled = settleField(now, scrubValue(state.start, dx, now.step, { shift: event.shiftKey, alt: event.altKey }));
      if ("value" in settled) { state.value = settled.value; setText(formatField(now, settled.value)); }
    },
    onPointerUp: () => {
      const state = drag.current;
      drag.current = null;
      if (!state) return;
      if (!state.moved) {
        focus();
        return;
      }
      setDragging(false);
      setText(null);
      send(state.value);
    },
    onPointerCancel: () => { if (drag.current) cancelDrag(); },
    onLostPointerCapture: () => { if (drag.current) cancelDrag(); },
  };

  return { input, handle, focus, text, focused, dragging, reason };
}

const fieldStyles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", gap: 5, margin: "2px 0 4px" },
  row: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  label: { width: 52, flexShrink: 0, color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: "17px", userSelect: "none", whiteSpace: "nowrap" },
  // 能拖的字：虚线下划线提示能左右拖
  grip: { cursor: "ew-resize", touchAction: "none", textDecorationLine: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 },
  box: {
    flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, height: 26, boxSizing: "border-box", padding: "0 7px",
    borderWidth: 1, borderStyle: "solid", borderRadius: radius.small, backgroundColor: color.surfaceRaised,
  },
  mark: { flexShrink: 0, color: color.textMuted, fontFamily: font.body, fontSize: 10.5, userSelect: "none", paddingRight: 1 },
  input: {
    flex: 1, minWidth: 0, width: "100%", height: 24, padding: 0, border: "none", outline: "none", background: "transparent",
    color: color.text, fontFamily: font.body, fontSize: 12, fontVariantNumeric: "tabular-nums",
  },
  animated: { color: color.textMuted, fontSize: 11 },
  unit: { flexShrink: 0, color: color.textMuted, fontFamily: font.body, fontSize: 10.5, pointerEvents: "none" },
};

const styles = StyleSheet.create({
  detail: { minHeight: 0, overflow: "hidden", borderWidth: 1, borderColor: color.border, borderRadius: radius.medium, backgroundColor: color.surface },
  detailHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 12, paddingRight: 8, height: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft },
  detailDot: { width: 8, height: 8, borderRadius: 2 },
  detailKind: { flex: 1, minWidth: 0, color: color.textSecondary, fontFamily: font.body, fontSize: 11.5, fontWeight: "600" },
  detailClose: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: radius.small },
  detailAction: { flexDirection: "row", alignItems: "center", gap: 3, height: 24, paddingHorizontal: 6, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surface },
  detailActionText: { color: color.text, fontFamily: font.body, fontSize: 11 },
  textEdit: { gap: 6, marginBottom: 2 },
  fieldInput: { minHeight: 34, paddingHorizontal: 11, color: color.text, fontFamily: font.body, fontSize: 13, borderWidth: 1, borderColor: color.border, borderRadius: radius.small, backgroundColor: color.surfaceRaised },
  textEditInput: { minHeight: 52, maxHeight: 160, paddingVertical: 7, lineHeight: 19, textAlignVertical: "top" },
  keyHint: { flexShrink: 1, color: color.textMuted, fontFamily: font.body, fontSize: 10.5 },
  detailBody: { gap: 7, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
  detailTitle: { marginBottom: 2, color: color.text, fontFamily: font.body, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  detailRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  detailLabel: { width: 52, flexShrink: 0, color: color.textMuted, fontFamily: font.body, fontSize: 11, lineHeight: 17 },
  detailValueBox: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: 6 },
  detailValue: { flex: 1, minWidth: 0, color: color.text, fontFamily: font.body, fontSize: 11.5, lineHeight: 17 },
  swatch: { width: 11, height: 11, marginTop: 3, borderRadius: 2, borderWidth: 1, borderColor: color.border },
  disabled: { opacity: 0.45 },
});
