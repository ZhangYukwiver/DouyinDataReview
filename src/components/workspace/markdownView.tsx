import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { kit } from "./CreatorKit";
import { ws } from "./motion";
import { workspaceColors as color, workspaceFonts as font, workspaceRadii as radius } from "./workspaceTheme";

// AI 回答的 Markdown：标题、表格、列表、引用、分隔线、**加粗**、[文字](链接)。从拆出去之前的解析库搬回来，去掉了流式晕开的动画。

export type MarkdownBlock = { kind: "h"; level: number; text: string } | { kind: "p" | "quote"; text: string } | { kind: "li"; marker: string; text: string } | { kind: "table"; rows: string[][] } | { kind: "hr" };

// 模型有时整张表只用全角竖线、行首也不带竖线
const isRow = (line: string) => /^[|｜]/u.test(line.trim()) || (line.match(/｜/gu)?.length ?? 0) >= 2;
const cells = (line: string) => line.trim().replace(/^[|｜]|[|｜]$/gu, "").split(/[|｜]/u).map((cell) => cell.trim().replace(/<br\s*\/?>/giu, "\n"));

export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "p", text: paragraph.join("\n") }); paragraph = []; };
  const lines = text.replace(/\r/gu, "").split("\n");
  const at = (index: number) => (lines[index] ?? "").trim();
  for (let index = 0; index < lines.length; index += 1) {
    const line = at(index);
    let match: RegExpMatchArray | null;
    if (!line || line.startsWith("```")) { flush(); continue; }
    if (isRow(line)) {
      flush();
      const rows: string[][] = [];
      // 表头下面那行 |---|---| 不算内容
      for (; index < lines.length && isRow(at(index)); index += 1) if (!/^[|｜:\s-]+$/u.test(at(index))) rows.push(cells(at(index)));
      index -= 1;
      blocks.push({ kind: "table", rows });
    } else if ((match = line.match(/^(#{1,6})\s+(.*)$/u))) { flush(); blocks.push({ kind: "h", level: match[1]!.length, text: match[2]! }); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/u.test(line)) { flush(); blocks.push({ kind: "hr" }); }
    else if ((match = line.match(/^>\s?(.*)$/u))) { flush(); blocks.push({ kind: "quote", text: match[1]! }); }
    else if ((match = line.match(/^([-*+]|\d+[.)、])\s+(.*)$/u))) { flush(); blocks.push({ kind: "li", marker: /\d/u.test(match[1]!) ? match[1]! : "•", text: match[2]! }); }
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** 行内：**加粗**、[文字](https://…) 链接、裸的 https 链接。链接点了交给 onLink（应用用系统浏览器打开）。 */
function Inline({ text, style, onLink }: { text: string; style?: object | object[]; onLink?: (url: string) => void }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)）」，。]+)/u);
  return <Text selectable style={style}>{parts.map((part, index) => {
    if (/^\*\*[^*]+\*\*$/u.test(part)) return <Text key={index} style={kit.strong}>{part.slice(2, -2)}</Text>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/u) ?? (/^https?:\/\//u.test(part) ? [part, part, part] : null);
    if (link) return <Text key={index} accessibilityRole="link" onPress={() => onLink?.(link[2]!)} style={styles.link}>{link[1]}</Text>;
    return part;
  })}</Text>;
}

export function Markdown({ text, compact = false, onLink }: { text: string; compact?: boolean; onLink?: (url: string) => void }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const body = compact ? [kit.body, styles.compactBody] : kit.body;
  return <View {...ws("md")} style={compact ? styles.compact : styles.markdown}>{blocks.map((block, index) => {
    if (block.kind === "h") return <Inline key={index} onLink={onLink} text={block.text} style={[styles.heading, block.level >= 3 && styles.headingSmall, compact && styles.headingCompact]} />;
    if (block.kind === "hr") return <View key={index} style={styles.hr} />;
    if (block.kind === "quote") return <Inline key={index} onLink={onLink} text={block.text} style={[body, styles.quote]} />;
    if (block.kind === "li") return <View key={index} style={styles.li}><Text style={[body, styles.marker]}>{block.marker}</Text><Inline onLink={onLink} text={block.text} style={[body, { flex: 1 }]} /></View>;
    if (block.kind === "table") {
      const columns = Math.max(...block.rows.map((row) => row.length));
      return <View key={index} {...ws("md-table")} style={styles.table}>
        {block.rows.map((row, rowIndex) => <View key={rowIndex} {...ws("md-tr", rowIndex === 0 && "md-th")} style={[styles.tr, rowIndex === 0 && styles.th]}>
          {Array.from({ length: columns }, (_, cell) => <View key={cell} {...ws("md-td")} style={[styles.td, compact && styles.tdCompact]}>
            <Inline onLink={onLink} text={row[cell] ?? ""} style={rowIndex === 0 ? styles.thText : styles.tdText} />
          </View>)}
        </View>)}
      </View>;
    }
    return <Inline key={index} onLink={onLink} text={block.text} style={body} />;
  })}</View>;
}

const styles = StyleSheet.create({
  markdown: { gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: color.borderSoft },
  compact: { gap: 6 },
  compactBody: { fontSize: 13, lineHeight: 21, color: color.text },
  heading: { color: color.text, fontFamily: font.body, fontSize: 16, lineHeight: 26, fontWeight: "600", marginTop: 8 },
  headingSmall: { fontSize: 14 },
  headingCompact: { fontSize: 13.5, lineHeight: 22, marginTop: 2 },
  hr: { height: 1, backgroundColor: color.borderSoft, marginVertical: 4 },
  quote: { paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: color.borderSoft, color: color.textMuted },
  li: { flexDirection: "row", gap: 8, paddingLeft: 4 },
  marker: { minWidth: 16, color: color.textMuted },
  link: { color: color.accentAction, textDecorationLine: "underline" },
  table: { borderWidth: 1, borderColor: color.borderSoft, borderRadius: radius.small, overflow: "hidden" },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: color.borderSoft },
  th: { backgroundColor: color.surfaceRaised },
  td: { flex: 1, minWidth: 0, padding: 10, borderRightWidth: 1, borderRightColor: color.borderSoft },
  tdCompact: { padding: 6 },
  thText: { color: color.text, fontFamily: font.body, fontSize: 12, lineHeight: 19, fontWeight: "600" },
  tdText: { color: color.textSecondary, fontFamily: font.body, fontSize: 12, lineHeight: 20 },
});
