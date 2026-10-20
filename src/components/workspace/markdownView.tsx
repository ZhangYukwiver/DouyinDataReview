import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parseMarkdown } from "../../services/videoAnalysis";
import { kit } from "./CreatorKit";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 回答的 Markdown（解析库的拆解、AI 剪辑的对话）：标题、表格、列表、引用、分隔线、**加粗**。
// compact 用在对话气泡里：字小一号、没有顶部分隔线。

function Inline({ text, style }: { text: string; style?: object | object[] }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/u);
  return <Text selectable style={style}>{parts.map((part, index) => /^\*\*[^*]+\*\*$/u.test(part)
    ? <Text key={index} style={kit.strong}>{part.slice(2, -2)}</Text> : part)}</Text>;
}

export function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const body = compact ? [kit.body, styles.compactBody] : kit.body;
  return <View style={compact ? styles.compact : styles.markdown}>{blocks.map((block, index) => {
    if (block.kind === "h") return <Inline key={index} text={block.text} style={[styles.heading, block.level >= 3 && styles.headingSmall, compact && styles.headingCompact]} />;
    if (block.kind === "hr") return <View key={index} style={styles.hr} />;
    if (block.kind === "quote") return <Inline key={index} text={block.text} style={[body, styles.quote]} />;
    if (block.kind === "li") return <View key={index} style={styles.li}><Text style={[body, styles.marker]}>{block.marker}</Text><Inline text={block.text} style={[body, { flex: 1 }]} /></View>;
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      return <View key={index} style={styles.table}>
        {block.rows.map((row, rowIndex) => <View key={rowIndex} style={[styles.tr, rowIndex === 0 && styles.th]}>
          {Array.from({ length: columns }, (_, cell) => <View key={cell} style={[styles.td, compact && styles.tdCompact]}><Inline text={row[cell] ?? ""} style={rowIndex === 0 ? styles.thText : styles.tdText} /></View>)}
        </View>)}
      </View>;
    }
    return <Inline key={index} text={block.text} style={body} />;
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
