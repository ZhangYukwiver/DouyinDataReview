import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { Download } from "lucide-react-native";
import type { MobileSnapshot } from "./collectionData";
import { cachedReport, reportFor, reportHtml, type MobileReport, type ReportMode } from "./mobileReport";
import { exportMobileFile } from "./mobileExport";
import { Button, C, Segmented, mono, serif, ui } from "./mobileUi";
import { STORY_STYLES, type StoryStyle } from "./StoryScreen";

const modes: Array<{ id: ReportMode; label: string }> = [{ id: "summary", label: "概览" }, { id: "living", label: "近期" }, { id: "annual", label: "年度" }];

// Each cover hints at its story's palette: ink night + amber / near-black + gold / newsprint + signal orange.
function StoryCover({ style }: { style: StoryStyle }) {
  const w = 132, h = 176, box = { width: "100%", height: "100%", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "xMidYMid slice" } as const;
  if (style === "trace") return <Svg {...box}>
    <Defs>
      <LinearGradient id="tn" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#1d2940" /><Stop offset="0.6" stopColor="#152033" /><Stop offset="1" stopColor="#090d15" /></LinearGradient>
      <RadialGradient id="ta" cx="0.7" cy="0.62" r="0.5"><Stop offset="0" stopColor="#eea44e" stopOpacity="0.55" /><Stop offset="1" stopColor="#eea44e" stopOpacity="0" /></RadialGradient>
    </Defs>
    <Rect width={w} height={h} fill="url(#tn)" /><Rect width={w} height={h} fill="url(#ta)" />
    <Circle cx={108} cy={30} r={40} stroke="#f6f1e4" strokeOpacity={0.35} strokeWidth={1} strokeDasharray="1 4" fill="none" />
    <Rect x={12} y={12} width={w - 24} height={h - 24} rx={10} stroke="#fefffc" strokeOpacity={0.35} fill="none" />
  </Svg>;
  if (style === "archive") return <Svg {...box}>
    <Rect width={w} height={h} fill="#0f0d0a" />
    <Rect x={10} y={10} width={w - 20} height={h - 20} stroke="#c9a46a" strokeOpacity={0.7} fill="none" />
    <Rect x={14} y={14} width={w - 28} height={h - 28} stroke="#c9a46a" strokeOpacity={0.3} fill="none" />
    {[0, 1, 2].map(i => <Line key={i} x1={28} x2={w - 28} y1={92 + i * 9} y2={92 + i * 9} stroke="#e3c8a6" strokeOpacity={0.18} />)}
    <Circle cx={w / 2} cy={58} r={16} stroke="#c9a46a" strokeOpacity={0.8} fill="none" /><Circle cx={w / 2} cy={58} r={3} fill="#e3c8a6" />
  </Svg>;
  return <Svg {...box}>
    <Rect width={w} height={h} fill="#ece5d5" /><Rect x={0} y={0} width={w} height={34} fill="#141210" />
    <Rect x={12} y={112} width={58} height={52} fill="#ff4d1f" />
    <Line x1={12} x2={w - 12} y1={100} y2={100} stroke="#141210" strokeWidth={2} />
    <Line x1={78} x2={w - 12} y1={124} y2={124} stroke="#141210" strokeWidth={1} /><Line x1={78} x2={w - 30} y1={136} y2={136} stroke="#141210" strokeWidth={1} />
  </Svg>;
}

const coverText: Record<StoryStyle, { color: string; sub: string }> = {
  trace: { color: "#f6f1e4", sub: "#eea44e" }, archive: { color: "#e3c8a6", sub: "#c9a46a" }, poster: { color: "#ece5d5", sub: "#ece5d5" },
};

export function ReportScreen({ snapshot, active, onCollect, onStory }: {
  snapshot: MobileSnapshot | null; active: boolean; onCollect: () => void; onStory: (style: StoryStyle) => void;
}) {
  const [mode, setMode] = useState<ReportMode>("summary");
  const [year, setYear] = useState<number>();
  const [report, setReport] = useState<MobileReport | null>(null);
  const [notice, setNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  const pending = Boolean(snapshot) && report !== (snapshot ? cachedReport(snapshot, mode, year) ?? null : null);
  useEffect(() => {
    if (!active || !snapshot) { if (!snapshot) setReport(null); return; }
    const hit = cachedReport(snapshot, mode, year);
    if (hit) { setReport(hit); return; }
    // Paint the new tab state first, then spend the JS thread on the report.
    const timer = setTimeout(() => setReport(reportFor(snapshot, mode, year)), 32);
    return () => clearTimeout(timer);
  }, [active, snapshot, mode, year]);

  async function exportReport() {
    if (!report || exporting) return;
    setExporting(true); setNotice("");
    try {
      const saved = await exportMobileFile(`DouyinDataReview-${mode}-${Date.now()}.html`, "text/html", reportHtml(report));
      setNotice(saved ? "报告已保存到所选文件夹，用浏览器就能离线打开。" : "已取消导出。");
    } catch { setNotice("报告导出失败，请重试并选择可写入的文件夹。本机数据仍保留。"); }
    finally { setExporting(false); }
  }
  const storyYear = report?.year ?? new Date().getFullYear();
  return <ScrollView contentContainerStyle={ui.content}>
    <View style={{ gap: 6, paddingTop: 8 }}>
      <Text style={ui.eyebrow}>YOUR YEAR · ON THIS PHONE</Text>
      <Text style={ui.heading}>报告</Text>
    </View>

    {snapshot ? <View style={{ gap: 12 }}>
      <View style={[ui.row, { justifyContent: "space-between" }]}>
        <Text style={ui.title}>年度故事</Text><Text style={ui.meta}>{storyYear} · 点封面直接打开</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {STORY_STYLES.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`打开${item.label}`} onPress={() => onStory(item.id)}
          style={({ pressed }) => [{ flex: 1, aspectRatio: 3 / 4, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: C.line, transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
          <StoryCover style={item.id} />
          <View style={{ position: "absolute", left: 12, right: 10, bottom: 12, top: item.id === "poster" ? 6 : 14, justifyContent: "space-between" }}>
            <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 8, letterSpacing: 1.6, color: coverText[item.id].sub }}>{item.en}</Text>
            <Text numberOfLines={1} adjustsFontSizeToFit style={{ fontFamily: item.id === "poster" ? undefined : serif, fontWeight: item.id === "poster" ? "900" : "400", fontSize: 19, lineHeight: 24,
              color: coverText[item.id].color }}>{item.label}</Text>
          </View>
        </Pressable>)}
      </View>
    </View> : null}

    <Segmented items={modes} value={mode} onChange={value => { setMode(value); setNotice(""); }} />

    {!snapshot ? <View style={[ui.card, { alignItems: "flex-start" }]}>
      <Text style={ui.title}>报告从第一条真实记录开始</Text>
      <Text style={ui.body}>先采集观看历史、喜欢或收藏。记录只存在这台手机里，报告会自动生成，断网也能看。</Text>
      <Button label="去采集" onPress={onCollect} />
    </View> : !report ? <View style={{ paddingVertical: 60, alignItems: "center", gap: 12 }}>
      <ActivityIndicator color={C.accent} /><Text style={ui.meta}>正在整理报告…</Text>
    </View> : <View style={{ gap: 14, opacity: pending ? 0.45 : 1 }}>
      {mode === "annual" && report.years.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {report.years.map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: value === report.year }}
          onPress={() => setYear(value)} style={[ui.chip, value === report.year && ui.chipOn]}>
          <Text style={[ui.chipText, value === report.year && { color: C.accent }]}>{value}</Text>
        </Pressable>)}
      </ScrollView> : null}

      <View style={{ gap: 8, paddingTop: 4 }}>
        <Text style={[ui.number, { fontSize: 26, lineHeight: 34 }]}>{report.title}</Text>
        <Text style={ui.meta}>{report.subtitle}</Text>
        <Text style={[ui.body, { fontSize: 13, lineHeight: 21 }]}>{report.coverage}</Text>
        <View style={[ui.row, { marginTop: 4 }]}>
          <Button label={exporting ? "正在导出…" : "导出离线报告"} kind="ghost" icon={Download} onPress={exportReport} disabled={exporting} />
        </View>
        {notice ? <Text accessibilityLiveRegion="polite" style={[ui.meta, { color: C.accent }]}>{notice}</Text> : null}
      </View>

      {report.sections.map((section, index) => {
        const max = Math.max(1, ...section.bars.map(bar => bar.count));
        return <View key={`${mode}:${index}`} style={ui.card}>
          <View style={[ui.row, { alignItems: "baseline" }]}>
            <Text style={{ fontFamily: mono, fontSize: 11, color: C.accent, letterSpacing: 1 }}>{String(index + 1).padStart(2, "0")}</Text>
            <Text style={[ui.title, { flex: 1 }]}>{section.title}</Text>
          </View>
          {section.description ? <Text style={ui.body}>{section.description}</Text> : null}
          {section.metrics.length > 0 ? <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 14 }}>
            {section.metrics.map((item, i) => <View key={i} style={{ width: "50%", paddingRight: 10, gap: 2 }}>
              <Text numberOfLines={2} style={[ui.number, { fontSize: item.value.length > 8 ? 16 : 26, lineHeight: item.value.length > 8 ? 22 : 32 }]}>{item.value}</Text>
              <Text style={ui.meta}>{item.label}</Text>
            </View>)}
          </View> : null}
          {section.bars.length > 0 ? <View style={{ gap: 10, paddingTop: 2 }}>
            {section.bars.map((item, i) => <View key={i} style={{ gap: 5 }}>
              <View style={[ui.row, { justifyContent: "space-between" }]}>
                <Text numberOfLines={1} style={{ flex: 1, color: C.text, fontSize: 13 }}>{item.label}</Text>
                <Text style={[ui.meta, { fontVariant: ["tabular-nums"] }]}>{item.count.toLocaleString("zh-CN")}</Text>
              </View>
              <View style={{ height: 6, backgroundColor: C.raised, borderRadius: 3, overflow: "hidden" }}>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: i === 0 ? C.accent : "rgba(240,162,78,0.45)", width: `${Math.max(2, item.count / max * 100)}%` }} />
              </View>
            </View>)}
          </View> : null}
          {section.notes.length > 0 ? <View style={{ gap: 4, borderLeftWidth: 2, borderColor: C.lineStrong, paddingLeft: 10 }}>
            {section.notes.map((note, i) => <Text key={i} style={ui.meta}>{note}</Text>)}
          </View> : null}
        </View>;
      })}
    </View>}
  </ScrollView>;
}
