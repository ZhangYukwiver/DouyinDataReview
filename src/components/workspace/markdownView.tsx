import React, { useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parseMarkdown } from "../../services/videoAnalysis";
import { kit } from "./CreatorKit";
import { ws } from "./motion";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 回答的 Markdown（解析库的拆解、AI 剪辑的对话）：标题、表格、列表、引用、分隔线、**加粗**。
// compact 用在对话气泡里：字小一号、没有顶部分隔线。
// inline 给了的话，行内的普通字交给它画（AI 剪辑回复里的片段、时间做成能点的）；解析库不传，和原来一样。
// ink 用在还在流式输出的回答上：新到的那几段字从模糊淡出到清楚（像墨晕开），新起的段落、表格行淡入，
// 不是一个字一个字硬蹦出来。动画在 aiCss 的 [data-ws~="ink"]。

/** 一段新到的字：key 是它在整段原文里的起点（不变，动画不会重放），fromEnd 是它离原文末尾多少个字 */
type InkMark = { key: number; fromEnd: number };
const INK = ws("ink");
const INK_BLOCK = ws("ink-block");
/** 新到的字晕开要多久，过了就并回普通文字（动画早放完了，并回去看不出变化） */
const INK_MS = 900;

/** 每次原文变长就记下这次的起点；只留最近 INK_MS 内的。原文变短（换了一轮回答）就从头记。 */
function useInk(text: string, on: boolean): InkMark[] {
  const marks = useRef<Array<{ at: number; time: number }>>([]);
  const seen = useRef(text.length);
  if (!on) return [];
  const now = Date.now();
  if (text.length < seen.current) marks.current = [];
  else if (text.length > seen.current) marks.current.push({ at: seen.current, time: now });
  seen.current = text.length;
  marks.current = marks.current.filter((mark) => now - mark.time < INK_MS);
  // 按去掉末尾空白的长度算：最后一段的字不带结尾的换行
  const end = text.trimEnd().length;
  return marks.current.filter((mark) => mark.at < end).map((mark) => ({ key: mark.at, fromEnd: end - mark.at }));
}

/** 一段字的结尾按新到的几段切开，每段包一层带晕开动画的 span；离末尾比这段还远的从开头算 */
function inkTail(text: string, tail: InkMark[]): React.ReactNode[] {
  const cuts = tail.map(({ key, fromEnd }) => ({ key, at: Math.max(0, text.length - fromEnd) }));
  return [text.slice(0, cuts[0]?.at ?? text.length), ...cuts.map((cut, index) =>
    <Text key={`ink${cut.key}`} {...INK}>{text.slice(cut.at, cuts[index + 1]?.at ?? text.length)}</Text>)];
}

/** 行内普通字怎么画：不给就原样 */
export type InlineRender = (text: string) => React.ReactNode;

function Inline({ text, style, tail, dataSet, inline }: { text: string; style?: object | object[]; tail?: InkMark[]; dataSet?: Record<string, string>; inline?: InlineRender }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/u);
  // 新到的字只会在最后一截：最后一截没闭合的 ** 还是普通字，闭合了的加粗整段直接出来
  const last = parts.pop() ?? "";
  const plain = (part: string, key: number) => (inline ? <React.Fragment key={key}>{inline(part)}</React.Fragment> : part);
  return <Text selectable {...{ dataSet }} style={style}>{parts.map((part, index) => /^\*\*[^*]+\*\*$/u.test(part)
    ? <Text key={index} style={kit.strong}>{plain(part.slice(2, -2), 0)}</Text> : plain(part, index))}{tail?.length ? inkTail(last, tail) : plain(last, parts.length)}</Text>;
}

export function Markdown({ text, compact = false, ink = false, inline }: { text: string; compact?: boolean; ink?: boolean; inline?: InlineRender }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const marks = useInk(text, ink);
  const body = compact ? [kit.body, styles.compactBody] : kit.body;
  const fresh = ink ? INK_BLOCK : null;
  return <View {...ws("md")} style={compact ? styles.compact : styles.markdown}>{blocks.map((block, index) => {
    const tail = index === blocks.length - 1 ? marks : undefined;
    if (block.kind === "h") return <Inline key={index} {...fresh} inline={inline} text={block.text} tail={tail} style={[styles.heading, block.level >= 3 && styles.headingSmall, compact && styles.headingCompact]} />;
    if (block.kind === "hr") return <View key={index} style={styles.hr} />;
    if (block.kind === "quote") return <Inline key={index} {...fresh} inline={inline} text={block.text} tail={tail} style={[body, styles.quote]} />;
    if (block.kind === "li") return <View key={index} {...fresh} style={styles.li}><Text style={[body, styles.marker]}>{block.marker}</Text><Inline inline={inline} text={block.text} tail={tail} style={[body, { flex: 1 }]} /></View>;
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      const lastRow = block.rows.length - 1;
      return <View key={index} {...ws("md-table")} style={styles.table}>
        {block.rows.map((row, rowIndex) => <View key={rowIndex} {...ws("md-tr", rowIndex === 0 && "md-th", ink && "ink-block")} style={[styles.tr, rowIndex === 0 && styles.th]}>
          {Array.from({ length: columns }, (_, cell) => <View key={cell} {...ws("md-td")} style={[styles.td, compact && styles.tdCompact]}>
            <Inline inline={inline} text={row[cell] ?? ""} tail={rowIndex === lastRow && cell === row.length - 1 ? tail : undefined} style={rowIndex === 0 ? styles.thText : styles.tdText} />
          </View>)}
        </View>)}
      </View>;
    }
    return <Inline key={index} {...fresh} inline={inline} text={block.text} tail={tail} style={body} />;
  })}</View>;
}

const styles = StyleSheet.create({
  markdown: { gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: color.borderSoft },
  compact: { gap: 6 },
  compactBody: { fontSize: 12.5, lineHeight: 20, color: color.text },
  heading: { color: color.text, fontFamily: font.body, fontSize: 16, lineHeight: 26, fontWeight: "600", marginTop: 8 },
  headingSmall: { fontSize: 14 },
  headingCompact: { fontSize: 13, lineHeight: 21, marginTop: 2 },
  hr: { height: 1, backgroundColor: color.borderSoft, marginVertical: 4 },
  quote: { paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: color.borderSoft, color: color.textMuted },
  li: { flexDirection: "row", gap: 8, paddingLeft: 4 },
  marker: { minWidth: 16, color: color.textMuted },
  table: { borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, overflow: "hidden" },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  th: { backgroundColor: color.surfaceRaised },
  td: { flex: 1, minWidth: 0, padding: 10, borderRightWidth: 1, borderRightColor: color.borderSoft },
  tdCompact: { padding: 6 },
  thText: { color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 19, fontWeight: "600" },
  tdText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, lineHeight: 20 },
});
